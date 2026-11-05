import { WoundState } from '../patient-care/model';
import { CareTask } from '../tasking/model';

export interface OutcomeRow {
  tenant_id: string;
  facility_id: string;
  clinician_id: string;
  patient_id: string;
  wound_id: string;
  wound_type: string;
  status: string;
  as_of_date: string;
  healed_30d: number;
  area_change_ratio: number;
  baseline_area_cm2: number;
  latest_area_cm2: number;
  depth_cm: number;
}

export interface TaskRow {
  tenant_id: string;
  facility_id: string;
  clinician_id: string;
  patient_id: string;
  task_id: string;
  task_type: string;
  status: string;
  due_date: string;
  as_of_date: string;
}

/** Anti-corruption layer: domain aggregates to metric-friendly rows. */
export function projectOutcomes(wounds: WoundState[], asOf: string): OutcomeRow[] {
  return wounds.map((wound) => {
    const assessments = wound.assessments.filter((assessment) => assessment.assessedAt.slice(0, 10) <= asOf);
    const earliest = assessments[0];
    const latest = assessments[assessments.length - 1];
    const baseline = earliest ? areaOf(earliest.measurements) : 0;
    const latestArea = latest ? areaOf(latest.measurements) : 0;
    const ratio = baseline === 0 ? 0 : (latestArea - baseline) / baseline;
    const closed = assessments.some((assessment) => assessment.closed);
    return {
      tenant_id: wound.tenantId,
      facility_id: wound.facilityId,
      clinician_id: wound.clinicianId,
      patient_id: wound.patientId,
      wound_id: wound.id,
      wound_type: wound.woundType,
      status: closed ? 'closed' : 'open',
      as_of_date: asOf,
      healed_30d: closed || ratio <= -0.4 ? 1 : 0,
      area_change_ratio: ratio,
      baseline_area_cm2: baseline,
      latest_area_cm2: latestArea,
      depth_cm: latest ? measurement(latest.measurements, 'depth-cm') : 0,
    };
  });
}

export function projectTasks(tasks: CareTask[], asOf: string): TaskRow[] {
  return tasks.map((task) => ({
    tenant_id: task.tenantId,
    facility_id: task.facilityId,
    clinician_id: task.clinicianId,
    patient_id: task.patientId,
    task_id: task.id,
    task_type: task.taskType,
    status: task.status,
    due_date: task.dueDate,
    as_of_date: asOf,
  }));
}

function areaOf(measurements: { code: string; value: number }[]): number {
  return measurement(measurements, 'area-cm2');
}

function measurement(measurements: { code: string; value: number }[], code: string): number {
  return measurements.find((item) => item.code === code)?.value ?? 0;
}
