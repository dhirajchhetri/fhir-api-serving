import { InProcessEventBus } from '../../domain/event-bus';
import { domainEvent, DomainEvent, FhirResourcePublishedPayload, WoundAssessedPayload } from '../../domain/events';
import { PatientCareRepository } from '../patient-care/repository';
import { TaskRepository } from '../tasking/service';
import { FhirStore } from './fhir-store';
import {
  resourcesForAssessment,
  toComorbidityConditions,
  toPatientResource,
  toRiskObservation,
  toTaskResource,
} from './fhir-mapper';
import { FhirResource } from './fhir-types';

export class FhirProjection {
  constructor(
    private readonly store: FhirStore,
    private readonly patients: PatientCareRepository,
    private readonly tasks: TaskRepository,
    private readonly bus: InProcessEventBus,
    private readonly ids: () => string,
    private readonly now: () => string,
  ) {}

  async publishPatient(tenantId: string, patientId: string): Promise<void> {
    const patient = this.patients.getPatient(tenantId, patientId);
    if (!patient) return;
    const resources = [toPatientResource(patient), ...toComorbidityConditions(patient)];
    for (const resource of resources) {
      await this.upsert(resource, { tenantId, patientId, facilityId: patient.facilityId });
    }
  }

  async publishTasks(tenantId: string): Promise<void> {
    for (const task of this.tasks.list(tenantId)) {
      const patient = this.patients.getPatient(tenantId, task.patientId);
      await this.upsert(toTaskResource(task), {
        tenantId,
        patientId: task.patientId,
        facilityId: patient?.facilityId ?? task.facilityId,
      });
    }
  }

  async onWoundAssessed(event: DomainEvent<WoundAssessedPayload>): Promise<void> {
    const wound = this.patients.getWound(event.tenantId, event.aggregateId);
    if (!wound) return;
    const resources = resourcesForAssessment(wound.snapshot, event.payload);
    for (const resource of resources) {
      await this.upsert(resource, {
        tenantId: event.tenantId,
        patientId: event.payload.patientId,
        facilityId: event.payload.facilityId,
      });
    }
  }

  async onTaskCompleted(tenantId: string, taskId: string): Promise<void> {
    const task = this.tasks.get(tenantId, taskId);
    if (!task) return;
    await this.upsert(toTaskResource(task), {
      tenantId,
      patientId: task.patientId,
      facilityId: task.facilityId,
    });
  }

  async onRiskScore(input: {
    tenantId: string;
    patientId: string;
    woundId: string;
    score: number;
    band: string;
    modelVersion: string;
    computedAt: string;
  }): Promise<void> {
    const patient = this.patients.getPatient(input.tenantId, input.patientId);
    await this.upsert(
      toRiskObservation(input),
      { tenantId: input.tenantId, patientId: input.patientId, facilityId: patient?.facilityId },
    );
  }

  private async upsert(
    resource: FhirResource,
    index: { tenantId: string; patientId?: string; facilityId?: string },
  ): Promise<void> {
    await this.store.upsert(resource, index);
    const payload: FhirResourcePublishedPayload = {
      resourceType: resource.resourceType,
      resourceId: resource.id,
      patientId: index.patientId,
    };
    await this.bus.publish([
      domainEvent('FhirResourcePublished', {
        id: this.ids(),
        occurredAt: this.now(),
        tenantId: index.tenantId,
        aggregateId: resource.id,
        payload,
      }),
    ]);
  }
}
