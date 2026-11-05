import { Wound } from '../src/contexts/patient-care/model';
import { completeTask } from '../src/contexts/tasking/model';
import { DomainError } from '../src/domain/errors';

const ids = { eventId: (() => { let n = 0; return () => `evt-${++n}`; })(), now: () => '2026-10-15T00:00:00Z' };

describe('wound aggregate', () => {
  const wound = Wound.open({
    id: 'wound-1',
    tenantId: 'tenant-demo',
    patientId: 'pat-1',
    facilityId: 'fac-harbor',
    clinicianId: 'clin-01',
    woundType: 'pressure-injury',
    onsetDate: '2026-09-01',
  });

  it('records an assessment and emits wound and measurement events', () => {
    const result = wound.recordAssessment({
      id: 'as-1',
      assessedAt: '2026-10-01T00:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'granulation',
      offloading: true,
      closed: false,
      measurements: [
        { code: 'area-cm2', value: 4, unit: 'cm2' },
        { code: 'depth-cm', value: 0.2, unit: 'cm' },
      ],
    }, ids);
    expect(result.wound.snapshot.assessments).toHaveLength(1);
    expect(result.events.map((event) => event.type)).toEqual([
      'WoundAssessed',
      'MeasurementRecorded',
      'MeasurementRecorded',
    ]);
  });

  it('rejects a negative measurement', () => {
    expect(() => wound.recordAssessment({
      assessedAt: '2026-10-01T00:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'slough',
      offloading: false,
      closed: false,
      measurements: [{ code: 'area-cm2', value: -1, unit: 'cm2' }],
    }, ids)).toThrow(DomainError);
  });

  it('rejects another assessment after closure', () => {
    const closed = wound.recordAssessment({
      assessedAt: '2026-10-01T00:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'epithelial',
      offloading: true,
      closed: true,
      measurements: [{ code: 'area-cm2', value: 0.4, unit: 'cm2' }],
    }, ids).wound;
    expect(closed.snapshot.status).toBe('closed');
    expect(() => closed.recordAssessment({
      assessedAt: '2026-10-02T00:00:00Z',
      clinicianId: 'clin-01',
      tissueType: 'epithelial',
      offloading: true,
      closed: false,
      measurements: [{ code: 'area-cm2', value: 0.4, unit: 'cm2' }],
    }, ids)).toThrow(/closed/);
  });
});

describe('care task', () => {
  it('completes once', () => {
    const task = {
      id: 'task-1',
      tenantId: 'tenant-demo',
      facilityId: 'fac-harbor',
      patientId: 'pat-1',
      woundId: 'wound-1',
      clinicianId: 'clin-01',
      taskType: 'dressing-change' as const,
      status: 'open' as const,
      dueDate: '2026-10-01',
    };
    const done = completeTask(task, '2026-10-01T12:00:00Z', ids);
    expect(done.task.status).toBe('completed');
    expect(done.events[0].type).toBe('CareTaskCompleted');
    expect(() => completeTask(done.task, '2026-10-02T12:00:00Z', ids)).toThrow(/already completed/);
  });
});
