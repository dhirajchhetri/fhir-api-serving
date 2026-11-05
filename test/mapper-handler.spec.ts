import { Wound } from '../src/contexts/patient-care/model';
import { WoundAssessedPayload } from '../src/domain/events';
import { handler } from '../services/fhir-mapper/handler';
import { WOUNDS } from '../src/seed/cohort';

describe('fhir mapper handler', () => {
  it('maps an assessment detail without calling HealthLake when no endpoint is set', async () => {
    delete process.env.FHIR_DATASTORE_ENDPOINT;
    const opened = Wound.open(WOUNDS[0]).recordAssessment({
      id: 'as-1001a',
      assessedAt: '2026-09-01T15:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'granulation',
      offloading: true,
      closed: false,
      measurements: [{ code: 'area-cm2', value: 12, unit: 'cm2' }],
    });
    const result = await handler({
      detail: {
        tenantId: 'tenant-demo',
        payload: opened.events[0].payload as WoundAssessedPayload,
        wound: opened.wound.snapshot,
      },
    });
    expect(result.resourceIds).toContain('Observation/obs-as-1001a-area-cm2');
    expect(result.resourceIds).toContain('Condition/cond-wound-wound-1001');
  });
});
