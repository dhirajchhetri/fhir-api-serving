import { PatientRecord, WoundType } from '../contexts/patient-care/model';
import { CareTask } from '../contexts/tasking/model';

export const TENANT_ID = 'tenant-demo';
export const SNAPSHOT_DATE = '2026-10-15';

const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';

export interface CohortAssessment {
  woundId: string;
  id: string;
  assessedAt: string;
  clinicianId: string;
  tissueType: 'granulation' | 'slough' | 'eschar' | 'epithelial';
  offloading: boolean;
  closed: boolean;
  area: number;
  depth: number;
}

export const PATIENTS: PatientRecord[] = [
  patient('pat-1001', 'fac-harbor', 'SYN-1001', 'Hale', 'Morgan', '1948-03-12', 'female', []),
  patient('pat-1002', 'fac-harbor', 'SYN-1002', 'Adler', 'Quinn', '1952-07-01', 'male', [
    { system: ICD10, code: 'I83.90', display: 'Asymptomatic varicose veins of unspecified lower extremity' },
  ]),
  patient('pat-1003', 'fac-harbor', 'SYN-1003', 'Chen', 'Riley', '1960-11-22', 'unknown', []),
  patient('pat-1004', 'fac-ridge', 'SYN-1004', 'Patel', 'Samir', '1944-01-30', 'male', [
    { system: ICD10, code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
  ]),
  patient('pat-1005', 'fac-ridge', 'SYN-1005', 'Blake', 'Jordan', '1958-05-17', 'female', []),
  patient('pat-1006', 'fac-harbor', 'SYN-1006', 'Nguyen', 'Avery', '1939-12-02', 'female', [
    { system: ICD10, code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
    { system: ICD10, code: 'I73.9', display: 'Peripheral vascular disease, unspecified' },
  ]),
];

export const WOUNDS: {
  id: string;
  tenantId: string;
  patientId: string;
  facilityId: string;
  clinicianId: string;
  woundType: WoundType;
  onsetDate: string;
}[] = [
  wound('wound-1001', 'pat-1001', 'fac-harbor', 'clin-01', 'pressure-injury', '2026-09-01'),
  wound('wound-1002', 'pat-1002', 'fac-harbor', 'clin-01', 'venous-ulcer', '2026-09-01'),
  wound('wound-1003', 'pat-1003', 'fac-harbor', 'clin-02', 'pressure-injury', '2026-09-01'),
  wound('wound-1004', 'pat-1004', 'fac-ridge', 'clin-03', 'diabetic-foot-ulcer', '2026-09-01'),
  wound('wound-1005', 'pat-1005', 'fac-ridge', 'clin-03', 'venous-ulcer', '2026-09-05'),
  wound('wound-1006', 'pat-1006', 'fac-harbor', 'clin-02', 'diabetic-foot-ulcer', '2026-09-15'),
];

export const ASSESSMENTS: CohortAssessment[] = [
  assess('wound-1001', 'as-1001a', '2026-09-01T15:00:00Z', 'clin-01', 'granulation', true, false, 12, 0.2),
  assess('wound-1001', 'as-1001b', '2026-10-01T15:00:00Z', 'clin-01', 'granulation', true, false, 6, 0.1),
  assess('wound-1002', 'as-1002a', '2026-09-01T15:00:00Z', 'clin-01', 'slough', true, false, 8, 0.3),
  assess('wound-1002', 'as-1002b', '2026-10-01T15:00:00Z', 'clin-01', 'slough', true, false, 7.6, 0.3),
  assess('wound-1003', 'as-1003a', '2026-09-01T15:00:00Z', 'clin-02', 'epithelial', true, false, 5, 0.2),
  assess('wound-1003', 'as-1003b', '2026-09-20T15:00:00Z', 'clin-02', 'epithelial', true, true, 1, 0),
  assess('wound-1004', 'as-1004a', '2026-09-01T15:00:00Z', 'clin-03', 'granulation', true, false, 20, 0.4),
  assess('wound-1004', 'as-1004b', '2026-10-01T15:00:00Z', 'clin-03', 'granulation', true, false, 8, 0.2),
  assess('wound-1005', 'as-1005a', '2026-09-05T15:00:00Z', 'clin-03', 'granulation', true, false, 4, 0.2),
  assess('wound-1005', 'as-1005b', '2026-09-25T15:00:00Z', 'clin-03', 'epithelial', true, true, 0.5, 0),
  assess('wound-1006', 'as-1006a', '2026-09-15T15:00:00Z', 'clin-02', 'slough', false, false, 15, 0.9),
  assess('wound-1006', 'as-1006b', '2026-10-10T15:00:00Z', 'clin-02', 'slough', false, false, 16, 0.9),
];

export const TASKS: CareTask[] = [
  task('task-01', 'pat-1001', 'wound-1001', 'fac-harbor', 'clin-01', 'dressing-change', '2026-09-20'),
  task('task-02', 'pat-1002', 'wound-1002', 'fac-harbor', 'clin-01', 'dressing-change', '2026-10-01'),
  task('task-03', 'pat-1003', 'wound-1003', 'fac-harbor', 'clin-02', 'visit', '2026-09-20'),
  task('task-04', 'pat-1006', 'wound-1006', 'fac-harbor', 'clin-02', 'visit', '2026-09-20'),
  task('task-05', 'pat-1006', 'wound-1006', 'fac-harbor', 'clin-02', 'visit', '2026-09-27'),
  task('task-06', 'pat-1006', 'wound-1006', 'fac-harbor', 'clin-02', 'visit', '2026-10-04'),
  task('task-07', 'pat-1006', 'wound-1006', 'fac-harbor', 'clin-02', 'dressing-change', '2026-10-08'),
  task('task-08', 'pat-1004', 'wound-1004', 'fac-ridge', 'clin-03', 'visit', '2026-10-01'),
  task('task-09', 'pat-1005', 'wound-1005', 'fac-ridge', 'clin-03', 'visit', '2026-09-25'),
];

export const COMPLETIONS: { id: string; completedAt: string }[] = [
  { id: 'task-01', completedAt: '2026-09-20T16:00:00Z' },
  { id: 'task-03', completedAt: '2026-09-20T16:00:00Z' },
  { id: 'task-04', completedAt: '2026-09-20T16:00:00Z' },
  { id: 'task-08', completedAt: '2026-10-01T16:00:00Z' },
  { id: 'task-09', completedAt: '2026-09-25T16:00:00Z' },
];

function patient(
  id: string,
  facilityId: string,
  mrn: string,
  familyName: string,
  givenName: string,
  birthDate: string,
  gender: PatientRecord['gender'],
  conditions: PatientRecord['conditions'],
): PatientRecord {
  return { id, tenantId: TENANT_ID, facilityId, mrn, familyName, givenName, birthDate, gender, conditions };
}

function wound(
  id: string,
  patientId: string,
  facilityId: string,
  clinicianId: string,
  woundType: WoundType,
  onsetDate: string,
) {
  return { id, tenantId: TENANT_ID, patientId, facilityId, clinicianId, woundType, onsetDate };
}

function assess(
  woundId: string,
  id: string,
  assessedAt: string,
  clinicianId: string,
  tissueType: CohortAssessment['tissueType'],
  offloading: boolean,
  closed: boolean,
  area: number,
  depth: number,
): CohortAssessment {
  return { woundId, id, assessedAt, clinicianId, tissueType, offloading, closed, area, depth };
}

function task(
  id: string,
  patientId: string,
  woundId: string,
  facilityId: string,
  clinicianId: string,
  taskType: CareTask['taskType'],
  dueDate: string,
): CareTask {
  return {
    id,
    tenantId: TENANT_ID,
    facilityId,
    patientId,
    woundId,
    clinicianId,
    taskType,
    status: 'open',
    dueDate,
  };
}
