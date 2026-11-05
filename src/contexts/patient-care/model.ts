import { randomUUID } from 'crypto';
import { DomainError } from '../../domain/errors';
import { domainEvent, DomainEvent, Measurement, MeasurementRecordedPayload, WoundAssessedPayload } from '../../domain/events';

export type TissueType = 'granulation' | 'slough' | 'eschar' | 'epithelial';
export type WoundStatus = 'open' | 'closed';
export type WoundType = 'pressure-injury' | 'venous-ulcer' | 'diabetic-foot-ulcer';

export const MEASUREMENT_CODES: readonly Measurement['code'][] = ['area-cm2', 'length-cm', 'width-cm', 'depth-cm'];

export interface Assessment {
  id: string;
  assessedAt: string;
  clinicianId: string;
  tissueType: TissueType;
  offloading: boolean;
  closed: boolean;
  measurements: Measurement[];
}

export interface WoundState {
  id: string;
  tenantId: string;
  patientId: string;
  facilityId: string;
  clinicianId: string;
  woundType: WoundType;
  onsetDate: string;
  status: WoundStatus;
  assessments: Assessment[];
}

export interface PatientRecord {
  id: string;
  tenantId: string;
  facilityId: string;
  mrn: string;
  familyName: string;
  givenName: string;
  birthDate: string;
  gender: 'female' | 'male' | 'unknown';
  /** Comorbidities separate from the wound condition itself. */
  conditions: { system: string; code: string; display: string }[];
}

export interface NewAssessment {
  id?: string;
  assessedAt: string;
  clinicianId: string;
  tissueType: TissueType;
  offloading: boolean;
  closed: boolean;
  measurements: Measurement[];
}

export class Wound {
  private constructor(private readonly state: WoundState) {}

  static open(state: Omit<WoundState, 'status' | 'assessments'> & { assessments?: Assessment[] }): Wound {
    return new Wound({ ...state, status: 'open', assessments: state.assessments ?? [] });
  }

  static rehydrate(state: WoundState): Wound {
    return new Wound(state);
  }

  get snapshot(): WoundState {
    return {
      ...this.state,
      assessments: this.state.assessments.map((assessment) => ({
        ...assessment,
        measurements: [...assessment.measurements],
      })),
    };
  }

  recordAssessment(
    input: NewAssessment,
    ids: { eventId: () => string; now: () => string } = { eventId: randomUUID, now: () => new Date().toISOString() },
  ): { wound: Wound; events: DomainEvent[] } {
    if (this.state.status === 'closed') {
      throw new DomainError('wound is closed');
    }
    if (!input.assessedAt) throw new DomainError('assessedAt is required');
    const area = input.measurements.find((measurement) => measurement.code === 'area-cm2');
    if (!area) throw new DomainError('an area-cm2 measurement is required');
    for (const measurement of input.measurements) {
      if (!MEASUREMENT_CODES.includes(measurement.code)) {
        throw new DomainError(`unknown measurement code ${measurement.code}`);
      }
      if (!Number.isFinite(measurement.value) || measurement.value < 0) {
        throw new DomainError('measurement values must be zero or greater');
      }
    }
    const assessment: Assessment = {
      id: input.id ?? ids.eventId(),
      assessedAt: input.assessedAt,
      clinicianId: input.clinicianId,
      tissueType: input.tissueType,
      offloading: input.offloading,
      closed: input.closed,
      measurements: input.measurements.map((measurement) => ({ ...measurement })),
    };
    const occurredAt = ids.now();
    const woundPayload: WoundAssessedPayload = {
      patientId: this.state.patientId,
      facilityId: this.state.facilityId,
      clinicianId: input.clinicianId,
      woundType: this.state.woundType,
      assessmentId: assessment.id,
      assessedAt: assessment.assessedAt,
      tissueType: assessment.tissueType,
      offloading: assessment.offloading,
      closed: assessment.closed,
      measurements: assessment.measurements,
    };
    const events: DomainEvent[] = [
      domainEvent( 'WoundAssessed', {
        id: ids.eventId(),
        occurredAt,
        tenantId: this.state.tenantId,
        aggregateId: this.state.id,
        payload: woundPayload,
      }),
    ];
    for (const measurement of assessment.measurements) {
      const payload: MeasurementRecordedPayload = {
        patientId: this.state.patientId,
        assessmentId: assessment.id,
        code: measurement.code,
        value: measurement.value,
        unit: measurement.unit,
        assessedAt: assessment.assessedAt,
      };
      events.push(domainEvent('MeasurementRecorded', {
        id: ids.eventId(),
        occurredAt,
        tenantId: this.state.tenantId,
        aggregateId: this.state.id,
        payload,
      }));
    }
    const next = new Wound({
      ...this.state,
      status: input.closed ? 'closed' : this.state.status,
      assessments: [...this.state.assessments, assessment],
    });
    return { wound: next, events };
  }
}
