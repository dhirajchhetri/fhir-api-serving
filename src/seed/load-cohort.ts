import { AnalyticsService } from '../contexts/analytics/analytics.service';
import { FhirProjection } from '../contexts/clinical-interop/projection';
import { PatientCareService } from '../contexts/patient-care/service';
import { RiskService } from '../contexts/risk/risk.service';
import { TaskingService } from '../contexts/tasking/service';
import { ASSESSMENTS, COMPLETIONS, PATIENTS, TASKS, TENANT_ID, WOUNDS } from './cohort';

export async function seedCohort(deps: {
  patientCare: PatientCareService;
  tasking: TaskingService;
  projection: FhirProjection;
  analytics: AnalyticsService;
  risk: RiskService;
}): Promise<void> {
  for (const patient of PATIENTS) deps.patientCare.registerPatient(patient);
  for (const wound of WOUNDS) deps.patientCare.openWound(wound);
  for (const task of TASKS) deps.tasking.schedule(task);
  for (const item of ASSESSMENTS) {
    await deps.patientCare.recordAssessment(TENANT_ID, item.woundId, {
      id: item.id,
      assessedAt: item.assessedAt,
      clinicianId: item.clinicianId,
      tissueType: item.tissueType,
      offloading: item.offloading,
      closed: item.closed,
      measurements: [
        { code: 'area-cm2', value: item.area, unit: 'cm2' },
        { code: 'depth-cm', value: item.depth, unit: 'cm' },
      ],
    });
  }
  for (const completion of COMPLETIONS) {
    await deps.tasking.complete(TENANT_ID, completion.id, completion.completedAt);
  }
  for (const patient of PATIENTS) await deps.projection.publishPatient(TENANT_ID, patient.id);
  await deps.projection.publishTasks(TENANT_ID);
  await deps.analytics.refresh();
  await deps.risk.scoreAll(TENANT_ID);
}
