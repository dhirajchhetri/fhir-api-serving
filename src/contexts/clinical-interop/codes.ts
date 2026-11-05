export const CS = {
  woundType: 'http://woundcare.example/fhir/CodeSystem/wound-type',
  measurement: 'http://woundcare.example/fhir/CodeSystem/wound-measurement',
  facility: 'http://woundcare.example/fhir/StructureDefinition/facility',
  synthetic: 'http://woundcare.example/fhir/CodeSystem/synthetic',
  mrn: 'http://woundcare.example/mrn',
  task: 'http://woundcare.example/fhir/CodeSystem/task-type',
  risk: 'http://woundcare.example/fhir/CodeSystem/risk-score',
} as const;

/**
 * Example SNOMED CT bindings for the synthetic wound types.
 * Confirm against the current release before any real terminology use.
 */
export const WOUND_TYPE_CODING: Record<string, { code: string; display: string }> = {
  'pressure-injury': { code: '399912005', display: 'Pressure ulcer' },
  'venous-ulcer': { code: '128045006', display: 'Venous ulcer' },
  'diabetic-foot-ulcer': { code: '371087003', display: 'Diabetic foot ulcer' },
};

export const MEASUREMENT_DISPLAY: Record<string, { display: string; unit: string }> = {
  'area-cm2': { display: 'Wound surface area', unit: 'cm2' },
  'length-cm': { display: 'Wound length', unit: 'cm' },
  'width-cm': { display: 'Wound width', unit: 'cm' },
  'depth-cm': { display: 'Wound depth', unit: 'cm' },
};

export const FHIR_TYPES = ['Patient', 'Observation', 'Condition', 'Encounter', 'Task'] as const;
export type FhirType = (typeof FHIR_TYPES)[number];

export function isFhirType(value: string): value is FhirType {
  return (FHIR_TYPES as readonly string[]).includes(value);
}
