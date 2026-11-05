import { resourcesForAssessment, toPatientResource } from '../src/contexts/clinical-interop/fhir-mapper';
import { InMemoryFhirStore } from '../src/contexts/clinical-interop/memory-fhir-store';
import { HealthLakeFhirStore } from '../src/contexts/clinical-interop/healthlake-fhir-store';
import { PATIENTS, WOUNDS } from '../src/seed/cohort';
import { Wound } from '../src/contexts/patient-care/model';
import { WoundAssessedPayload } from '../src/domain/events';

describe('fhir mapper', () => {
  it('projects an assessment to encounter, condition, and observations with stable ids', () => {
    const opened = Wound.open(WOUNDS[0]);
    const recorded = opened.recordAssessment({
      id: 'as-1001a',
      assessedAt: '2026-09-01T15:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'granulation',
      offloading: true,
      closed: false,
      measurements: [
        { code: 'area-cm2', value: 12, unit: 'cm2' },
        { code: 'depth-cm', value: 0.2, unit: 'cm' },
      ],
    });
    const payload = recorded.events[0].payload as WoundAssessedPayload;
    const resources = resourcesForAssessment(recorded.wound.snapshot, payload);
    expect(resources.map((resource) => `${resource.resourceType}/${resource.id}`)).toEqual([
      'Encounter/enc-as-1001a',
      'Condition/cond-wound-wound-1001',
      'Observation/obs-as-1001a-area-cm2',
      'Observation/obs-as-1001a-depth-cm',
    ]);
    const again = resourcesForAssessment(recorded.wound.snapshot, payload);
    expect(again.map((resource) => resource.id)).toEqual(resources.map((resource) => resource.id));
  });

  it('marks patients as synthetic and keeps the facility extension', () => {
    const resource = toPatientResource(PATIENTS[0]);
    expect(resource.meta?.tag?.[0].code).toBe('synthetic');
    expect(JSON.stringify(resource.extension)).toContain('Location/fac-harbor');
    expect(JSON.stringify(resource)).toContain('SYN-1001');
  });
});

describe('in-memory fhir store', () => {
  it('upserts idempotently and bumps the version', async () => {
    const store = new InMemoryFhirStore();
    const resource = toPatientResource(PATIENTS[0]);
    const index = { tenantId: 'tenant-demo', patientId: 'pat-1001', facilityId: 'fac-harbor' };
    const first = await store.upsert(resource, index);
    const second = await store.upsert(resource, index);
    expect(first.meta?.versionId).toBe('1');
    expect(second.meta?.versionId).toBe('2');
    const byName = await store.search('tenant-demo', 'Patient', { name: 'Hale' });
    expect(byName).toHaveLength(1);
    const otherTenant = await store.read('other', 'Patient', 'pat-1001');
    expect(otherTenant).toBeUndefined();
  });
});

describe('healthlake fhir store', () => {
  it('puts and reads through the injected http client', async () => {
    const calls: string[] = [];
    const store = new HealthLakeFhirStore('https://healthlake.example/datastore/demo/r4', {
      async request(url, init) {
        calls.push(`${init.method} ${url}`);
        if (init.method === 'PUT') {
          return { status: 200, text: init.body ?? '' };
        }
        return { status: 200, text: JSON.stringify(toPatientResource(PATIENTS[1])) };
      },
    });
    await store.upsert(toPatientResource(PATIENTS[1]), {
      tenantId: 'tenant-demo',
      patientId: 'pat-1002',
      facilityId: 'fac-harbor',
    });
    const read = await store.read('tenant-demo', 'Patient', 'pat-1002');
    expect(read?.id).toBe('pat-1002');
    expect(calls[0]).toContain('PUT');
    expect(await store.read('tenant-demo', 'Patient', 'missing')).toBeUndefined();
  });
});
