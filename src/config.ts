import fs from 'fs';

export interface AppConfig {
  port: number;
  jwtPublicKeyPem?: string;
  jwksUri?: string;
  jwtIssuer: string;
  jwtAudience: string;
  fhirBackend: 'memory' | 'healthlake';
  healthLakeBaseUrl?: string;
  awsRegion: string;
  analyticsBackend: 'sqlite' | 'athena';
  athenaWorkgroup?: string;
  athenaDatabase: string;
  athenaOutput?: string;
  riskBackend: 'reference' | 'sagemaker';
  sagemakerEndpoint?: string;
  redisUrl?: string;
  awsEndpointUrl?: string;
  auditBucket?: string;
  idempotencyTable?: string;
  seed: boolean;
  snapshotDate: string;
  defaultTimeStart: string;
  defaultTimeEnd: string;
  tenantId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    jwtPublicKeyPem: readPublicKey(env),
    jwksUri: env.JWKS_URI,
    jwtIssuer: env.JWT_ISSUER ?? 'local-dev',
    jwtAudience: env.JWT_AUDIENCE ?? 'woundcare-api',
    fhirBackend: env.FHIR_BACKEND === 'healthlake' ? 'healthlake' : 'memory',
    healthLakeBaseUrl: env.HEALTHLAKE_BASE_URL,
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    analyticsBackend: env.ANALYTICS_BACKEND === 'athena' ? 'athena' : 'sqlite',
    athenaWorkgroup: env.ATHENA_WORKGROUP,
    athenaDatabase: env.ATHENA_DATABASE ?? 'woundcare_curated',
    athenaOutput: env.ATHENA_OUTPUT,
    riskBackend: env.RISK_BACKEND === 'sagemaker' ? 'sagemaker' : 'reference',
    sagemakerEndpoint: env.SAGEMAKER_ENDPOINT,
    redisUrl: env.REDIS_URL,
    awsEndpointUrl: env.AWS_ENDPOINT_URL,
    auditBucket: env.AUDIT_BUCKET,
    idempotencyTable: env.IDEMPOTENCY_TABLE,
    seed: env.SEED !== 'false',
    snapshotDate: env.SNAPSHOT_DATE ?? '2026-10-15',
    defaultTimeStart: env.DEFAULT_TIME_START ?? '2026-01-01',
    defaultTimeEnd: env.DEFAULT_TIME_END ?? '2027-01-01',
    tenantId: env.TENANT_ID ?? 'tenant-demo',
  };
}

function readPublicKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.JWT_PUBLIC_KEY) return env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  const path = env.JWT_PUBLIC_KEY_PATH ?? 'dev-keys/jwt-public.pem';
  if (fs.existsSync(path)) return fs.readFileSync(path, 'utf8');
  return undefined;
}
