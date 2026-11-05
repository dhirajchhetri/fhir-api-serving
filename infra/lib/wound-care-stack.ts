import path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as healthlake from 'aws-cdk-lib/aws-healthlake';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class WoundCareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const key = new kms.Key(this, 'DataKey', {
      enableKeyRotation: true,
      alias: 'woundcare-data',
      description: 'Customer-managed key for wound-care data stores',
    });
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowHealthLake',
      principals: [new iam.ServicePrincipal('healthlake.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey', 'kms:CreateGrant'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `healthlake.${this.region}.amazonaws.com` } },
    }));

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addGatewayEndpoint('DynamoDb', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', { vpc, description: 'Interface endpoints' });
    for (const [name, service] of [
      ['Athena', ec2.InterfaceVpcEndpointAwsService.ATHENA],
      ['Glue', ec2.InterfaceVpcEndpointAwsService.GLUE],
      ['HealthLake', ec2.InterfaceVpcEndpointAwsService.HEALTHLAKE],
      ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
      ['SageMakerRuntime', ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME],
    ] as const) {
      vpc.addInterfaceEndpoint(name, { service, securityGroups: [endpointSg], privateDnsEnabled: true });
    }

    const raw = bucket(this, 'Raw', key, false);
    const curated = bucket(this, 'Curated', key, false);
    const features = bucket(this, 'Features', key, false);
    const models = bucket(this, 'Models', key, false);
    const athenaResults = bucket(this, 'AthenaResults', key, false);
    const audit = new s3.Bucket(this, 'Audit', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(365)),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const idempotency = new dynamodb.Table(this, 'Idempotency', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const metricRegistry = new dynamodb.Table(this, 'MetricRegistry', {
      partitionKey: { name: 'metricId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const database = new rds.DatabaseCluster(this, 'EmrDatabase', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      storageEncryptionKey: key,
      defaultDatabaseName: 'woundcare',
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Redis subnets',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });
    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'Redis' });
    const cache = new elasticache.CfnReplicationGroup(this, 'Cache', {
      replicationGroupDescription: 'Patient summary cache',
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      kmsKeyId: key.keyArn,
      cacheSubnetGroupName: cacheSubnets.ref,
      securityGroupIds: [cacheSg.securityGroupId],
    });

    const neptuneSg = new ec2.SecurityGroup(this, 'NeptuneSg', { vpc, description: 'Semantic graph' });
    const neptuneSubnets = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnets', {
      dbSubnetGroupDescription: 'Semantic graph subnets',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });
    const graph = new neptune.CfnDBCluster(this, 'SemanticGraph', {
      dbSubnetGroupName: neptuneSubnets.ref,
      vpcSecurityGroupIds: [neptuneSg.securityGroupId],
      storageEncrypted: true,
      kmsKeyId: key.keyArn,
      iamAuthEnabled: true,
    });
    new neptune.CfnDBInstance(this, 'SemanticGraphInstance', {
      dbInstanceClass: 'db.t3.medium',
      dbClusterIdentifier: graph.ref,
    });

    const fhir = new healthlake.CfnFHIRDatastore(this, 'FhirStore', {
      datastoreName: 'woundcare-fhir',
      datastoreTypeVersion: 'R4',
      sseConfiguration: {
        kmsEncryptionConfig: { cmkType: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn },
      },
    });

    const catalogName = 'woundcare_curated';
    new glue.CfnDatabase(this, 'Catalog', {
      catalogId: this.account,
      databaseInput: { name: catalogName, description: 'Curated wound-care metrics' },
    });
    glueTable(this, 'OutcomesTable', catalogName, 'curated_wound_outcomes', curated.s3UrlForObject('wound_outcomes/'), [
      ['tenant_id', 'string'], ['facility_id', 'string'], ['clinician_id', 'string'],
      ['patient_id', 'string'], ['wound_id', 'string'], ['wound_type', 'string'],
      ['status', 'string'], ['as_of_date', 'string'], ['healed_30d', 'int'],
      ['area_change_ratio', 'double'], ['baseline_area_cm2', 'double'],
      ['latest_area_cm2', 'double'], ['depth_cm', 'double'],
    ]);
    glueTable(this, 'TasksTable', catalogName, 'curated_care_tasks', curated.s3UrlForObject('care_tasks/'), [
      ['tenant_id', 'string'], ['facility_id', 'string'], ['clinician_id', 'string'],
      ['patient_id', 'string'], ['task_id', 'string'], ['task_type', 'string'],
      ['status', 'string'], ['due_date', 'string'], ['as_of_date', 'string'],
    ]);
    const glueRole = new iam.Role(this, 'GlueRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
    });
    raw.grantRead(glueRole);
    curated.grantReadWrite(glueRole);
    key.grantEncryptDecrypt(glueRole);
    new glue.CfnJob(this, 'FlattenExport', {
      name: 'woundcare-flatten-export',
      role: glueRole.roleArn,
      glueVersion: '4.0',
      numberOfWorkers: 2,
      workerType: 'G.1X',
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: curated.s3UrlForObject('scripts/flatten_export.py'),
      },
      defaultArguments: {
        '--raw_prefix': raw.s3UrlForObject('healthlake/'),
        '--curated_prefix': curated.s3UrlForObject(''),
      },
    });

    const workgroup = new athena.CfnWorkGroup(this, 'TenantWorkgroup', {
      name: 'woundcare-tenant-demo',
      workGroupConfiguration: {
        bytesScannedCutoffPerQuery: 100_000_000,
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: { outputLocation: athenaResults.s3UrlForObject('results/') },
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
      },
    });

    new lakeformation.CfnDataLakeSettings(this, 'DataLakeSettings', {
      admins: [{ dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:root` }],
    });

    const userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: true }),
        facility_ids: new cognito.StringAttribute({ mutable: true }),
        patient_id: new cognito.StringAttribute({ mutable: true }),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const client = userPool.addClient('ApiClient', {
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: ['http://localhost:3000/callback'],
      },
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
    });
    for (const group of ['clinician', 'analyst', 'patient', 'partner', 'auditor']) {
      new cognito.CfnUserPoolGroup(this, `Group${group}`, { userPoolId: userPool.userPoolId, groupName: group });
    }

    const bus = new events.EventBus(this, 'DomainBus', { eventBusName: 'woundcare' });
    new events.Archive(this, 'DomainArchive', {
      sourceEventBus: bus,
      eventPattern: { source: ['woundcare.patient-care', 'woundcare.tasking', 'woundcare.risk'] },
      retention: cdk.Duration.days(30),
    });
    const mapperDlq = new sqs.Queue(this, 'MapperDlq', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: cdk.Duration.days(14),
    });
    const mapperLog = new logs.LogGroup(this, 'MapperLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const mapper = new nodejs.NodejsFunction(this, 'FhirMapper', {
      entry: path.join(__dirname, '../../services/fhir-mapper/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: mapperLog,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        FHIR_DATASTORE_ENDPOINT: fhir.attrDatastoreEndpoint,
      },
    });
    mapper.addToRolePolicy(new iam.PolicyStatement({
      actions: ['healthlake:CreateResource', 'healthlake:UpdateResource', 'healthlake:ReadResource'],
      resources: [fhir.attrDatastoreArn],
    }));
    key.grantEncryptDecrypt(mapper);
    new events.Rule(this, 'MapAssessments', {
      eventBus: bus,
      eventPattern: { detailType: ['WoundAssessed'] },
      targets: [new targets.LambdaFunction(mapper, { deadLetterQueue: mapperDlq, retryAttempts: 2 })],
    });

    const apiImage = this.node.tryGetContext('apiImage') ?? 'public.ecr.aws/docker/library/node:22-bookworm-slim';
    const taskRole = new iam.Role(this, 'ApiTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    idempotency.grantReadWriteData(taskRole);
    metricRegistry.grantReadData(taskRole);
    audit.grantPut(taskRole);
    athenaResults.grantReadWrite(taskRole);
    curated.grantRead(taskRole);
    key.grantEncryptDecrypt(taskRole);
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
      resources: [
        `arn:aws:athena:${this.region}:${this.account}:workgroup/${workgroup.name}`,
      ],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/${catalogName}`,
        `arn:aws:glue:${this.region}:${this.account}:table/${catalogName}/*`,
      ],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['healthlake:ReadResource', 'healthlake:SearchWithGet'],
      resources: [fhir.attrDatastoreArn],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sagemaker:InvokeEndpoint'],
      resources: [`arn:aws:sagemaker:${this.region}:${this.account}:endpoint/woundcare-nonhealing-risk`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lakeformation:GetDataAccess'],
      resources: ['*'],
    }));
    if (database.secret) database.secret.grantRead(taskRole);

    new lakeformation.CfnPrincipalPermissions(this, 'ApiCuratedSelect', {
      permissions: ['SELECT'],
      permissionsWithGrantOption: [],
      principal: { dataLakePrincipalIdentifier: taskRole.roleArn },
      resource: {
        tableWithColumns: {
          catalogId: this.account,
          databaseName: catalogName,
          name: 'curated_wound_outcomes',
          columnWildcard: { excludedColumnNames: ['patient_id'] },
        },
      },
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      vpc,
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
      publicLoadBalancer: true,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry(apiImage),
        containerPort: 3000,
        taskRole,
        environment: {
          PORT: '3000',
          FHIR_BACKEND: 'healthlake',
          HEALTHLAKE_BASE_URL: fhir.attrDatastoreEndpoint,
          ANALYTICS_BACKEND: 'athena',
          ATHENA_WORKGROUP: 'woundcare-tenant-demo',
          ATHENA_DATABASE: catalogName,
          ATHENA_OUTPUT: athenaResults.s3UrlForObject('results/'),
          RISK_BACKEND: 'sagemaker',
          SAGEMAKER_ENDPOINT: 'woundcare-nonhealing-risk',
          AUDIT_BUCKET: audit.bucketName,
          IDEMPOTENCY_TABLE: idempotency.tableName,
          JWKS_URI: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/jwks.json`,
          JWT_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
          JWT_AUDIENCE: client.userPoolClientId,
          SEED: 'false',
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'api',
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
    });
    service.targetGroup.configureHealthCheck({ path: '/health' });
    cacheSg.addIngressRule(service.service.connections.securityGroups[0], ec2.Port.tcp(6379), 'api to redis');
    database.connections.allowDefaultPortFrom(service.service);
    neptuneSg.addIngressRule(service.service.connections.securityGroups[0], ec2.Port.tcp(8182), 'api to neptune');
    endpointSg.addIngressRule(service.service.connections.securityGroups[0], ec2.Port.tcp(443), 'api to aws endpoints');

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      createDefaultStage: true,
    });
    const authorizer = new authorizers.HttpUserPoolAuthorizer('Cognito', userPool, { userPoolClients: [client] });
    const integration = new integrations.HttpUrlIntegration('Alb', `http://${service.loadBalancer.loadBalancerDnsName}/{proxy}`);
    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpUrlIntegration('Health', `http://${service.loadBalancer.loadBalancerDnsName}/health`),
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration,
      authorizer,
    });

    const smRole = new iam.Role(this, 'SageMakerRole', { assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com') });
    models.grantRead(smRole);
    features.grantReadWrite(smRole);
    key.grantEncryptDecrypt(smRole);
    smRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/sagemaker/*`],
    }));
    const model = new sagemaker.CfnModel(this, 'RiskModel', {
      executionRoleArn: smRole.roleArn,
      primaryContainer: {
        image: '763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.2.0-cpu-py310',
        modelDataUrl: models.s3UrlForObject('nonhealing-risk/model.tar.gz'),
        environment: { SAGEMAKER_PROGRAM: 'inference.py' },
      },
    });
    const endpointConfig = new sagemaker.CfnEndpointConfig(this, 'RiskEndpointConfig', {
      productionVariants: [{
        modelName: model.attrModelName,
        variantName: 'AllTraffic',
        initialInstanceCount: 1,
        instanceType: 'ml.m5.large',
        initialVariantWeight: 1,
      }],
      kmsKeyId: key.keyArn,
    });
    new sagemaker.CfnEndpoint(this, 'RiskEndpoint', {
      endpointName: 'woundcare-nonhealing-risk',
      endpointConfigName: endpointConfig.attrEndpointConfigName,
    });
    new sagemaker.CfnFeatureGroup(this, 'WoundFeatures', {
      featureGroupName: 'wound-risk-features',
      recordIdentifierFeatureName: 'wound_id',
      eventTimeFeatureName: 'event_time',
      roleArn: smRole.roleArn,
      featureDefinitions: [
        { featureName: 'wound_id', featureType: 'String' },
        { featureName: 'event_time', featureType: 'String' },
        { featureName: 'wound_type', featureType: 'String' },
        { featureName: 'area_change_ratio', featureType: 'Fractional' },
        { featureName: 'comorbidity_count', featureType: 'Integral' },
        { featureName: 'visit_adherence', featureType: 'Fractional' },
        { featureName: 'depth_cm', featureType: 'Fractional' },
        { featureName: 'offloading', featureType: 'Integral' },
      ],
      onlineStoreConfig: { EnableOnlineStore: true },
      offlineStoreConfig: {
        S3StorageConfig: { S3Uri: features.s3UrlForObject('offline/'), KmsKeyId: key.keyArn },
        DisableGlueTableCreation: false,
      },
    });

    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'FhirDatastoreEndpoint', { value: fhir.attrDatastoreEndpoint });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: cache.attrPrimaryEndPointAddress });
  }
}

function bucket(scope: Construct, id: string, key: kms.IKey, lock: boolean): s3.Bucket {
  return new s3.Bucket(scope, id, {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: key,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    objectLockEnabled: lock,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}

function glueTable(
  scope: Construct,
  id: string,
  databaseName: string,
  tableName: string,
  location: string,
  columns: [string, string][],
): glue.CfnTable {
  return new glue.CfnTable(scope, id, {
    catalogId: cdk.Stack.of(scope).account,
    databaseName,
    tableInput: {
      name: tableName,
      tableType: 'EXTERNAL_TABLE',
      parameters: { classification: 'parquet' },
      storageDescriptor: {
        columns: columns.map(([name, type]) => ({ name, type })),
        location,
        inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
        outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
        serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
      },
    },
  });
}
