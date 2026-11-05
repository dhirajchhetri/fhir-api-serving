export type EventType =
  | 'WoundAssessed'
  | 'MeasurementRecorded'
  | 'CareTaskCompleted'
  | 'RiskScoreComputed'
  | 'FhirResourcePublished';

export interface DomainEvent<T = unknown> {
  id: string;
  type: EventType;
  occurredAt: string;
  tenantId: string;
  aggregateId: string;
  payload: T;
}

export interface Measurement {
  code: 'area-cm2' | 'length-cm' | 'width-cm' | 'depth-cm';
  value: number;
  unit: string;
}

export interface WoundAssessedPayload {
  patientId: string;
  facilityId: string;
  clinicianId: string;
  woundType: string;
  assessmentId: string;
  assessedAt: string;
  tissueType: string;
  offloading: boolean;
  closed: boolean;
  measurements: Measurement[];
}

export interface MeasurementRecordedPayload {
  patientId: string;
  assessmentId: string;
  code: Measurement['code'];
  value: number;
  unit: string;
  assessedAt: string;
}

export interface CareTaskCompletedPayload {
  patientId: string;
  facilityId: string;
  woundId: string;
  taskType: string;
  completedAt: string;
}

export interface RiskScoreComputedPayload {
  patientId: string;
  woundId: string;
  score: number;
  band: string;
  modelVersion: string;
}

export interface FhirResourcePublishedPayload {
  resourceType: string;
  resourceId: string;
  patientId?: string;
}

export function domainEvent<T>(
  type: EventType,
  fields: Omit<DomainEvent<T>, 'type'>,
): DomainEvent<T> {
  return { type, ...fields };
}
