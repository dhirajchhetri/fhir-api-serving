import { extractFeatures } from '../src/contexts/risk/features';
import { DECISION_SUPPORT_DISCLAIMER, referenceScore } from '../src/contexts/risk/reference-scorer';
import { SageMakerRiskScorer as EndpointScorer } from '../src/contexts/risk/sagemaker-scorer';
import { CircuitBreaker } from '../src/common/resilience/circuit-breaker';
import { redactPhi } from '../src/common/phi/redact';
import { PhiLogger } from '../src/common/phi/phi-logger';
import { DomainError } from '../src/domain/errors';

describe('reference risk score', () => {
  it('scores an obviously high and an obviously low feature vector', () => {
    const high = referenceScore({
      woundType: 'diabetic-foot-ulcer',
      areaChangeRatio: 0.2,
      comorbidityCount: 4,
      visitAdherence: 0,
      baselineAreaCm2: 15,
      depthCm: 3,
      tissueType: 'eschar',
      offloading: false,
    });
    const low = referenceScore({
      woundType: 'pressure-injury',
      areaChangeRatio: -0.5,
      comorbidityCount: 0,
      visitAdherence: 1,
      baselineAreaCm2: 12,
      depthCm: 0,
      tissueType: 'epithelial',
      offloading: true,
    });
    expect(high.score).toBe(0.9498);
    expect(high.band).toBe('high');
    expect(low.score).toBe(0.2315);
    expect(low.band).toBe('low');
    expect(high.modelVersion).toBe('reference-heuristic-0.1.0');
    expect(DECISION_SUPPORT_DISCLAIMER).toMatch(/does not start/);
  });

  it('derives adherence and area change from the wound and its tasks', () => {
    const features = extractFeatures({
      id: 'wound-1006',
      tenantId: 'tenant-demo',
      patientId: 'pat-1006',
      facilityId: 'fac-harbor',
      clinicianId: 'clin-02',
      woundType: 'diabetic-foot-ulcer',
      onsetDate: '2026-09-15',
      status: 'open',
      assessments: [
        assessment('2026-09-15T15:00:00Z', 15, false),
        assessment('2026-10-10T15:00:00Z', 16, false),
      ],
    }, 2, [
      task('completed'),
      task('open'),
      task('open'),
      task('open'),
    ]);
    expect(features.visitAdherence).toBe(0.25);
    expect(features.comorbidityCount).toBe(2);
    expect(features.areaChangeRatio).toBeCloseTo(1 / 15);
    expect(referenceScore(features).band).toBe('high');
  });
});

describe('sagemaker scorer contract', () => {
  it('reads score and model version from the endpoint body', async () => {
    const scorer = new EndpointScorer(async () => JSON.stringify({ score: 0.42, modelVersion: 'model-7' }), 'woundcare-nonhealing-risk');
    const result = await scorer.score({
      woundType: 'venous-ulcer',
      areaChangeRatio: 0,
      comorbidityCount: 1,
      visitAdherence: 1,
      baselineAreaCm2: 8,
      depthCm: 0.2,
      tissueType: 'slough',
      offloading: true,
    });
    expect(result.score).toBe(0.42);
    expect(result.band).toBe('moderate');
    expect(result.modelVersion).toBe('model-7');
  });

  it('opens the circuit after repeated endpoint failures', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1_000, () => now);
    const scorer = new EndpointScorer(async () => { throw new Error('down'); }, 'endpoint', breaker);
    const features = {
      woundType: 'venous-ulcer',
      areaChangeRatio: 0,
      comorbidityCount: 0,
      visitAdherence: 1,
      baselineAreaCm2: 1,
      depthCm: 0,
      tissueType: 'granulation' as const,
      offloading: true,
    };
    await expect(scorer.score(features)).rejects.toThrow(/down/);
    await expect(scorer.score(features)).rejects.toThrow(/down/);
    await expect(scorer.score(features)).rejects.toBeInstanceOf(DomainError);
    now = 1_000;
    await expect(scorer.score(features)).rejects.toThrow(/down/);
  });
});

describe('phi-safe logging', () => {
  it('redacts names, identifiers, and synthetic MRNs', () => {
    const redacted = redactPhi({
      familyName: 'Hale',
      nested: { identifier: [{ value: 'SYN-1001' }], note: 'mrn SYN-1006 stays out of logs' },
    });
    expect(JSON.stringify(redacted)).not.toContain('Hale');
    expect(JSON.stringify(redacted)).not.toContain('SYN-1001');
    expect(JSON.stringify(redacted)).not.toContain('SYN-1006');
    expect(JSON.stringify(redacted)).toContain('[redacted]');
    const lines: string[] = [];
    const logger = new PhiLogger((line) => lines.push(line));
    logger.info('http', { path: '/fhir/r4/Patient/pat-1001', family: 'Hale', mrn: 'SYN-1002' });
    expect(lines[0]).not.toContain('Hale');
    expect(lines[0]).not.toContain('SYN-1002');
    expect(lines[0]).toContain('pat-1001');
  });
});

function assessment(assessedAt: string, area: number, offloading: boolean) {
  return {
    id: assessedAt,
    assessedAt,
    clinicianId: 'clin-02',
    tissueType: 'slough' as const,
    offloading,
    closed: false,
    measurements: [
      { code: 'area-cm2' as const, value: area, unit: 'cm2' },
      { code: 'depth-cm' as const, value: 0.9, unit: 'cm' },
    ],
  };
}

function task(status: 'open' | 'completed') {
  return {
    id: status + Math.random(),
    tenantId: 'tenant-demo',
    facilityId: 'fac-harbor',
    patientId: 'pat-1006',
    woundId: 'wound-1006',
    clinicianId: 'clin-02',
    taskType: 'visit' as const,
    status,
    dueDate: '2026-10-01',
  };
}
