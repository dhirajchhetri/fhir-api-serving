import { CareTask } from '../tasking/model';
import { PatientRecord, WoundState } from '../patient-care/model';
import { WoundAssessedPayload } from '../../domain/events';
import { CS, MEASUREMENT_DISPLAY, WOUND_TYPE_CODING } from './codes';
import { FhirResource } from './fhir-types';

const SYNTHETIC_TAG = { system: CS.synthetic, code: 'synthetic' };

export function toPatientResource(patient: PatientRecord): FhirResource {
  return {
    resourceType: 'Patient',
    id: patient.id,
    meta: { tag: [SYNTHETIC_TAG] },
    extension: [
      {
        url: CS.facility,
        valueReference: { reference: `Location/${patient.facilityId}` },
      },
    ],
    identifier: [{ system: CS.mrn, value: patient.mrn }],
    name: [{ use: 'official', family: patient.familyName, given: [patient.givenName] }],
    gender: patient.gender,
    birthDate: patient.birthDate,
  };
}

export function toComorbidityConditions(patient: PatientRecord): FhirResource[] {
  return patient.conditions.map((condition, index) => ({
    resourceType: 'Condition',
    id: `cond-${patient.id}-${index + 1}`,
    meta: { tag: [SYNTHETIC_TAG] },
    clinicalStatus: coding('http://terminology.hl7.org/CodeSystem/condition-clinical', 'active', 'Active'),
    category: [coding('http://terminology.hl7.org/CodeSystem/condition-category', 'problem-list-item', 'Problem List Item')],
    code: {
      coding: [{ system: condition.system, code: condition.code, display: condition.display }],
      text: condition.display,
    },
    subject: { reference: `Patient/${patient.id}` },
  }));
}

export function resourcesForAssessment(wound: WoundState, payload: WoundAssessedPayload): FhirResource[] {
  const woundCoding = WOUND_TYPE_CODING[wound.woundType];
  const encounter: FhirResource = {
    resourceType: 'Encounter',
    id: `enc-${payload.assessmentId}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'finished',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'AMB',
      display: 'ambulatory',
    },
    subject: { reference: `Patient/${wound.patientId}` },
    period: { start: payload.assessedAt, end: payload.assessedAt },
    serviceProvider: { reference: `Location/${wound.facilityId}` },
  };
  const condition: FhirResource = {
    resourceType: 'Condition',
    id: `cond-wound-${wound.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    clinicalStatus: coding(
      'http://terminology.hl7.org/CodeSystem/condition-clinical',
      payload.closed ? 'resolved' : 'active',
      payload.closed ? 'Resolved' : 'Active',
    ),
    category: [coding('http://terminology.hl7.org/CodeSystem/condition-category', 'encounter-diagnosis', 'Encounter Diagnosis')],
    code: {
      coding: [
        { system: CS.woundType, code: wound.woundType, display: woundCoding?.display ?? wound.woundType },
        ...(woundCoding ? [{ system: 'http://snomed.info/sct', code: woundCoding.code, display: woundCoding.display }] : []),
      ],
    },
    subject: { reference: `Patient/${wound.patientId}` },
    onsetDateTime: wound.onsetDate,
  };
  const observations = payload.measurements.map((measurement) => {
    const display = MEASUREMENT_DISPLAY[measurement.code];
    return {
      resourceType: 'Observation',
      id: `obs-${payload.assessmentId}-${measurement.code}`,
      meta: { tag: [SYNTHETIC_TAG] },
      status: 'final',
      category: [coding('http://terminology.hl7.org/CodeSystem/observation-category', 'exam', 'Exam')],
      code: {
        coding: [{ system: CS.measurement, code: measurement.code, display: display?.display ?? measurement.code }],
      },
      subject: { reference: `Patient/${wound.patientId}` },
      encounter: { reference: `Encounter/enc-${payload.assessmentId}` },
      effectiveDateTime: payload.assessedAt,
      valueQuantity: {
        value: measurement.value,
        unit: measurement.unit,
        system: 'http://unitsofmeasure.org',
        code: measurement.unit,
      },
    } satisfies FhirResource;
  });
  return [encounter, condition, ...observations];
}

export function toTaskResource(task: CareTask): FhirResource {
  return {
    resourceType: 'Task',
    id: `task-${task.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: task.status === 'completed' ? 'completed' : 'requested',
    intent: 'order',
    code: {
      coding: [{ system: CS.task, code: task.taskType, display: task.taskType }],
    },
    for: { reference: `Patient/${task.patientId}` },
    owner: { reference: `Practitioner/${task.clinicianId}` },
    restriction: { period: { end: task.dueDate } },
    executionPeriod: task.completedAt ? { end: task.completedAt } : undefined,
  };
}

export function toRiskObservation(input: {
  patientId: string;
  woundId: string;
  score: number;
  band: string;
  modelVersion: string;
  computedAt: string;
}): FhirResource {
  return {
    resourceType: 'Observation',
    id: `obs-risk-${input.woundId}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'final',
    category: [coding('http://terminology.hl7.org/CodeSystem/observation-category', 'survey', 'Survey')],
    code: {
      coding: [{ system: CS.risk, code: 'non-healing-risk', display: 'Non-healing risk score' }],
    },
    subject: { reference: `Patient/${input.patientId}` },
    focus: [{ reference: `Condition/cond-wound-${input.woundId}` }],
    effectiveDateTime: input.computedAt,
    valueQuantity: { value: input.score, unit: '1', system: 'http://unitsofmeasure.org', code: '1' },
    interpretation: [{ text: input.band }],
    note: [{ text: `model:${input.modelVersion}` }],
    extension: [
      {
        url: 'http://woundcare.example/fhir/StructureDefinition/decision-support-only',
        valueBoolean: true,
      },
    ],
  };
}

function coding(system: string, code: string, display: string): { coding: { system: string; code: string; display: string }[] } {
  return { coding: [{ system, code, display }] };
}
