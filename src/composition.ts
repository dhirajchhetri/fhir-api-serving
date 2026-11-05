import { randomUUID } from 'crypto';
import { AthenaClient } from '@aws-sdk/client-athena';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import Redis from 'ioredis';
import { AuditLog, MemoryAuditSink, ObjectAuditSink, ObjectStore } from './common/audit/audit-log';
import { JwksTokenVerifier, PemTokenVerifier, TokenVerifier } from './common/auth/jwt-verifier';
import { Cache, MemoryCache, RedisCache } from './common/cache/cache';
import { IdempotencyStore, MemoryIdempotencyStore, TableIdempotencyStore } from './common/idempotency';
import { PhiLogger } from './common/phi/phi-logger';
import { AppConfig } from './config';
import { ClinicalService, FhirReadService } from './api/access';
import { AnalyticsService } from './contexts/analytics/analytics.service';
import { AthenaAnalyticsEngine, athenaDriverFromClient } from './contexts/analytics/athena-engine';
import { SqliteAnalyticsEngine } from './contexts/analytics/sqlite-engine';
import { FhirStore } from './contexts/clinical-interop/fhir-store';
import { HealthLakeFhirStore, sigV4HealthLakeHttp } from './contexts/clinical-interop/healthlake-fhir-store';
import { InMemoryFhirStore } from './contexts/clinical-interop/memory-fhir-store';
import { FhirProjection } from './contexts/clinical-interop/projection';
import { InProcessEventBus } from './domain/event-bus';
import { CareTaskCompletedPayload, DomainEvent, RiskScoreComputedPayload, WoundAssessedPayload } from './domain/events';
import { DomainError } from './domain/errors';
import { InMemoryPatientCareRepository } from './contexts/patient-care/repository';
import { PatientCareService } from './contexts/patient-care/service';
import { ReferenceRiskScorer } from './contexts/risk/reference-scorer';
import { RiskService } from './contexts/risk/risk.service';
import { sageMakerInvoke, SageMakerRiskScorer } from './contexts/risk/sagemaker-scorer';
import { seedCohort } from './seed/load-cohort';
import { InMemoryTaskRepository, TaskingService } from './contexts/tasking/service';

export const GRAPH = Symbol('GRAPH');

export interface ServiceGraph {
  config: AppConfig;
  logger: PhiLogger;
  verifier: TokenVerifier;
  audit: AuditLog;
  cache: Cache;
  fhirRead: FhirReadService;
  clinical: ClinicalService;
  analytics: AnalyticsService;
  risk: RiskService;
}

export async function buildServices(config: AppConfig): Promise<ServiceGraph> {
  if (!config.jwksUri && !config.jwtPublicKeyPem) {
    throw new DomainError('JWT_PUBLIC_KEY or JWKS_URI is required before the API can start', 'config', 500);
  }
  const logger = new PhiLogger();
  const verifier: TokenVerifier = config.jwksUri
    ? new JwksTokenVerifier(config.jwksUri, config.jwtIssuer, config.jwtAudience)
    : new PemTokenVerifier(config.jwtPublicKeyPem as string, config.jwtIssuer, config.jwtAudience);
  const bus = new InProcessEventBus();
  const patients = new InMemoryPatientCareRepository();
  const tasks = new InMemoryTaskRepository();
  const fhirStore = await buildFhirStore(config);
  const ids = () => randomUUID();
  const now = () => new Date().toISOString();
  const projection = new FhirProjection(fhirStore, patients, tasks, bus, ids, now);
  const patientCare = new PatientCareService(patients, bus, ids, now);
  const tasking = new TaskingService(tasks, bus, ids, now);
  const engine = await buildAnalyticsEngine(config);
  const analytics = new AnalyticsService(
    engine,
    patients,
    tasks,
    config.tenantId,
    config.snapshotDate,
    { start: config.defaultTimeStart, end: config.defaultTimeEnd },
  );
  const scorer = buildScorer(config);
  const risk = new RiskService(scorer, patients, tasks, bus, ids, now);
  const cache = buildCache(config);
  const audit = new AuditLog(await buildAuditSink(config));
  const idempotency = buildIdempotency(config);

  bus.subscribe(async (event: DomainEvent) => {
    if (event.type === 'WoundAssessed') {
      const payload = event.payload as WoundAssessedPayload;
      await projection.onWoundAssessed(event as DomainEvent<WoundAssessedPayload>);
      await risk.onWoundAssessed(event as DomainEvent<WoundAssessedPayload>);
      await analytics.refresh();
      await cache.del(`summary:${event.tenantId}:${payload.patientId}`);
    } else if (event.type === 'CareTaskCompleted') {
      const payload = event.payload as CareTaskCompletedPayload;
      await projection.onTaskCompleted(event.tenantId, event.aggregateId);
      await analytics.refresh();
      await cache.del(`summary:${event.tenantId}:${payload.patientId}`);
    } else if (event.type === 'RiskScoreComputed') {
      const payload = event.payload as RiskScoreComputedPayload;
      const latest = risk.latest(event.tenantId, payload.woundId);
      if (latest) {
        await projection.onRiskScore({
          tenantId: event.tenantId,
          patientId: latest.patientId,
          woundId: latest.woundId,
          score: latest.score,
          band: latest.band,
          modelVersion: latest.modelVersion,
          computedAt: latest.computedAt,
        });
      }
      await cache.del(`summary:${event.tenantId}:${payload.patientId}`);
    } else if (event.type === 'MeasurementRecorded') {
      await analytics.refresh();
    }
  });

  if (config.seed) {
    await seedCohort({ patientCare, tasking, projection, analytics, risk });
  }

  return {
    config,
    logger,
    verifier,
    audit,
    cache,
    fhirRead: new FhirReadService(fhirStore, audit, config.tenantId),
    clinical: new ClinicalService(patients, patientCare, tasks, tasking, risk, audit, cache, idempotency, config.tenantId),
    analytics,
    risk,
  };
}

async function buildFhirStore(config: AppConfig): Promise<FhirStore> {
  if (config.fhirBackend === 'healthlake') {
    if (!config.healthLakeBaseUrl) throw new DomainError('HEALTHLAKE_BASE_URL is required', 'config', 500);
    const http = await sigV4HealthLakeHttp(config.awsRegion);
    return new HealthLakeFhirStore(config.healthLakeBaseUrl.replace(/\/$/, ''), http);
  }
  return new InMemoryFhirStore();
}

async function buildAnalyticsEngine(config: AppConfig): Promise<SqliteAnalyticsEngine | AthenaAnalyticsEngine> {
  if (config.analyticsBackend === 'athena') {
    if (!config.athenaWorkgroup || !config.athenaOutput) {
      throw new DomainError('ATHENA_WORKGROUP and ATHENA_OUTPUT are required', 'config', 500);
    }
    const client = new AthenaClient({ region: config.awsRegion, endpoint: config.awsEndpointUrl });
    return new AthenaAnalyticsEngine(athenaDriverFromClient({
      client,
      database: config.athenaDatabase,
      workgroup: config.athenaWorkgroup,
      outputLocation: config.athenaOutput,
    }));
  }
  const engine = new SqliteAnalyticsEngine();
  await engine.init();
  return engine;
}

function buildScorer(config: AppConfig): ReferenceRiskScorer | SageMakerRiskScorer {
  if (config.riskBackend === 'sagemaker') {
    if (!config.sagemakerEndpoint) throw new DomainError('SAGEMAKER_ENDPOINT is required', 'config', 500);
    const client = new SageMakerRuntimeClient({ region: config.awsRegion, endpoint: config.awsEndpointUrl });
    return new SageMakerRiskScorer(sageMakerInvoke(client, config.sagemakerEndpoint), config.sagemakerEndpoint);
  }
  return new ReferenceRiskScorer();
}

function buildCache(config: AppConfig): Cache {
  if (!config.redisUrl) return new MemoryCache();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  return new RedisCache(redis);
}

async function buildAuditSink(config: AppConfig): Promise<MemoryAuditSink | ObjectAuditSink> {
  if (!config.auditBucket || !config.awsEndpointUrl) return new MemoryAuditSink();
  const client = new S3Client({
    region: config.awsRegion,
    endpoint: config.awsEndpointUrl,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
  });
  const store: ObjectStore = {
    async putJson(bucket, key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body), ContentType: 'application/json' }));
    },
    async listJson(bucket, prefix) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const keys = (listed.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key));
      const bodies: unknown[] = [];
      for (const key of keys) {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const text = await object.Body?.transformToString();
        if (text) bodies.push(JSON.parse(text));
      }
      return bodies;
    },
  };
  return new ObjectAuditSink(store, config.auditBucket);
}

function buildIdempotency(config: AppConfig): IdempotencyStore {
  if (!config.idempotencyTable || !config.awsEndpointUrl) return new MemoryIdempotencyStore();
  const client = new DynamoDBClient({
    region: config.awsRegion,
    endpoint: config.awsEndpointUrl,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
  });
  const table = config.idempotencyTable;
  return new TableIdempotencyStore({
    async get(key) {
      const found = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: key } } }));
      return found.Item?.response?.S;
    },
    async putIfAbsent(key, response) {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { pk: { S: key }, response: { S: response } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  });
}
