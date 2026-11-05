import { randomUUID } from 'crypto';
import { InProcessEventBus } from '../../domain/event-bus';
import { DomainError } from '../../domain/errors';
import { NewAssessment, PatientRecord, Wound } from './model';
import { PatientCareRepository } from './repository';

export class PatientCareService {
  constructor(
    private readonly repository: PatientCareRepository,
    private readonly bus: InProcessEventBus,
    private readonly ids: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  registerPatient(patient: PatientRecord): void {
    if (this.repository.getPatient(patient.tenantId, patient.id)) {
      throw new DomainError(`patient ${patient.id} already exists`);
    }
    this.repository.savePatient(patient);
  }

  openWound(input: {
    id: string;
    tenantId: string;
    patientId: string;
    facilityId: string;
    clinicianId: string;
    woundType: Wound['snapshot']['woundType'];
    onsetDate: string;
  }): Wound {
    const patient = this.repository.getPatient(input.tenantId, input.patientId);
    if (!patient) throw new DomainError('patient not found', 'not_found', 404);
    if (patient.facilityId !== input.facilityId) {
      throw new DomainError('wound facility does not match the patient');
    }
    if (this.repository.getWound(input.tenantId, input.id)) {
      throw new DomainError(`wound ${input.id} already exists`);
    }
    const wound = Wound.open(input);
    this.repository.saveWound(wound);
    return wound;
  }

  async recordAssessment(tenantId: string, woundId: string, input: NewAssessment): Promise<{ assessmentId: string }> {
    const current = this.repository.getWound(tenantId, woundId);
    if (!current) throw new DomainError('wound not found', 'not_found', 404);
    const { wound, events } = current.recordAssessment(input, { eventId: this.ids, now: this.now });
    this.repository.saveWound(wound);
    await this.bus.publish(events);
    const assessed = events.find((event) => event.type === 'WoundAssessed');
    const payload = assessed?.payload as { assessmentId: string };
    return { assessmentId: payload.assessmentId };
  }
}
