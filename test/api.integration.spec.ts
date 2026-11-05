import { generateKeyPairSync } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/api/exception-filter';
import { AppModule } from '../src/app.module';
import { GRAPH, ServiceGraph } from '../src/composition';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.JWT_PUBLIC_KEY = publicPem;
process.env.SEED = 'true';
process.env.FHIR_BACKEND = 'memory';
process.env.ANALYTICS_BACKEND = 'sqlite';
process.env.RISK_BACKEND = 'reference';
delete process.env.JWKS_URI;
delete process.env.AWS_ENDPOINT_URL;

function token(claims: Record<string, unknown>): string {
  return jwt.sign(claims, privatePem, {
    algorithm: 'RS256',
    expiresIn: '1h',
    issuer: 'local-dev',
    audience: 'woundcare-api',
  });
}

const clinician = token({
  sub: 'user-clinician-harbor',
  'cognito:groups': ['clinician'],
  'custom:tenant_id': 'tenant-demo',
  'custom:facility_ids': 'fac-harbor',
});
const analyst = token({
  sub: 'user-analyst-1',
  'cognito:groups': ['analyst'],
  'custom:tenant_id': 'tenant-demo',
});
const patient = token({
  sub: 'user-patient-1001',
  'cognito:groups': ['patient'],
  'custom:tenant_id': 'tenant-demo',
  'custom:patient_id': 'pat-1001',
});
const partner = token({
  sub: 'user-partner-1',
  'cognito:groups': ['partner'],
  'custom:tenant_id': 'tenant-demo',
});
const auditor = token({
  sub: 'user-auditor-1',
  'cognito:groups': ['auditor'],
  'custom:tenant_id': 'tenant-demo',
});

describe('wound care API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    const graph = app.get<ServiceGraph>(GRAPH);
    const lines: string[] = [];
    graph.logger.setSink((line) => lines.push(line));
    (app as INestApplication & { logLines: string[] }).logLines = lines;
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health and the capability statement without a token', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    const metadata = await request(app.getHttpServer()).get('/fhir/r4/metadata').expect(200);
    expect(metadata.body.fhirVersion).toBe('4.0.1');
    expect(metadata.body.rest[0].resource.map((resource: { type: string }) => resource.type)).toEqual([
      'Patient', 'Observation', 'Condition', 'Encounter', 'Task',
    ]);
  });

  it('rejects a missing token and a token with alg none', async () => {
    await request(app.getHttpServer()).get('/fhir/r4/Patient/pat-1001').set('x-purpose-of-use', 'treatment').expect(401);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.`;
    await request(app.getHttpServer()).get('/fhir/r4/Patient/pat-1001').set('authorization', `Bearer ${none}`).set('x-purpose-of-use', 'treatment').expect(401);
  });

  it('enforces purpose, role, facility, and patient scope on FHIR reads', async () => {
    await request(app.getHttpServer()).get('/fhir/r4/Patient/pat-1001').set('authorization', `Bearer ${clinician}`).expect(400);
    const own = await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1001')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    expect(own.body.id).toBe('pat-1001');
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1004')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(403);
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1002')
      .set('authorization', `Bearer ${patient}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(403);
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1001')
      .set('authorization', `Bearer ${patient}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1001')
      .set('authorization', `Bearer ${partner}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(403);
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1001')
      .set('authorization', `Bearer ${partner}`)
      .set('x-purpose-of-use', 'operations')
      .expect(200);
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient/pat-1001')
      .set('authorization', `Bearer ${analyst}`)
      .set('x-purpose-of-use', 'operations')
      .expect(403);
  });

  it('keeps names out of the audit log', async () => {
    await request(app.getHttpServer())
      .get('/fhir/r4/Patient')
      .query({ name: 'Hale' })
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    const audit = await request(app.getHttpServer())
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${auditor}`)
      .set('x-purpose-of-use', 'operations')
      .expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('Hale');
    expect(JSON.stringify(audit.body)).not.toContain('SYN-1001');
    expect(audit.body.records.some((record: { queryKeys: string[] }) => record.queryKeys.includes('name'))).toBe(true);
  });

  it('runs governed metrics over the synthetic cohort', async () => {
    const healing = await request(app.getHttpServer())
      .post('/api/v1/analytics/query')
      .set('authorization', `Bearer ${analyst}`)
      .set('x-purpose-of-use', 'operations')
      .send({ metric: 'healing_rate_30d', dimensions: ['facility_id'], timeRange: { start: '2026-01-01', end: '2027-01-01' } })
      .expect(200);
    const byFacility = Object.fromEntries(healing.body.rows.map((row: { facility_id: string; healing_rate: number }) => [row.facility_id, row.healing_rate]));
    expect(byFacility['fac-harbor']).toBeCloseTo(0.5);
    expect(byFacility['fac-ridge']).toBeCloseTo(1);
    expect(healing.body.sql).toContain('tenant_id = ?');
    expect(healing.body.sql).not.toContain('tenant-demo');

    const overdue = await request(app.getHttpServer())
      .post('/api/v1/analytics/query')
      .set('authorization', `Bearer ${analyst}`)
      .set('x-purpose-of-use', 'operations')
      .send({ search: 'overdue dressing', dimensions: ['facility_id'] })
      .expect(200);
    expect(overdue.body.metric).toBe('overdue_dressing_changes');
    expect(overdue.body.rows.find((row: { facility_id: string }) => row.facility_id === 'fac-harbor').overdue_tasks).toBe(2);

    await request(app.getHttpServer())
      .post('/api/v1/analytics/query')
      .set('authorization', `Bearer ${analyst}`)
      .set('x-purpose-of-use', 'operations')
      .send({ metric: 'healing_rate_30d', filters: { wound_type: "pressure-injury' OR 1=1" } })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/analytics/query')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .send({ metric: 'healing_rate_30d' })
      .expect(403);
  });

  it('returns decision-support risk scores and projects a new assessment', async () => {
    const high = await request(app.getHttpServer())
      .get('/api/v1/patients/pat-1006/wounds/wound-1006/risk')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    expect(high.body.band).toBe('high');
    expect(high.body.decisionSupportOnly).toBe(true);
    expect(high.body.disclaimer).toMatch(/decision support/);
    expect(high.body.score).toBeCloseTo(0.8665);

    const low = await request(app.getHttpServer())
      .get('/api/v1/patients/pat-1001/wounds/wound-1001/risk')
      .set('authorization', `Bearer ${patient}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    expect(low.body.band).toBe('low');

    const created = await request(app.getHttpServer())
      .post('/api/v1/wounds/wound-1002/assessments')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .set('idempotency-key', 'assess-1002-once')
      .send({
        assessedAt: '2026-10-20T15:00:00Z',
        tissueType: 'granulation',
        offloading: true,
        closed: false,
        measurements: [{ code: 'area-cm2', value: 7, unit: 'cm2' }],
      })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/api/v1/wounds/wound-1002/assessments')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .set('idempotency-key', 'assess-1002-once')
      .send({
        assessedAt: '2026-10-21T15:00:00Z',
        tissueType: 'slough',
        offloading: false,
        closed: true,
        measurements: [{ code: 'area-cm2', value: 1, unit: 'cm2' }],
      })
      .expect(201);
    expect(replay.body.assessmentId).toBe(created.body.assessmentId);

    const observations = await request(app.getHttpServer())
      .get('/fhir/r4/Observation')
      .query({ patient: 'Patient/pat-1002', code: 'area-cm2' })
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .expect(200);
    const ids = observations.body.entry.map((entry: { resource: { id: string } }) => entry.resource.id);
    expect(ids).toContain(`obs-${created.body.assessmentId}-area-cm2`);
    expect(ids.filter((id: string) => id.includes('2026-10-21'))).toHaveLength(0);

    await request(app.getHttpServer())
      .post('/api/v1/wounds/wound-1003/assessments')
      .set('authorization', `Bearer ${clinician}`)
      .set('x-purpose-of-use', 'treatment')
      .send({
        assessedAt: '2026-10-22T15:00:00Z',
        tissueType: 'epithelial',
        offloading: true,
        closed: false,
        measurements: [{ code: 'area-cm2', value: 1, unit: 'cm2' }],
      })
      .expect(400);
  });
});
