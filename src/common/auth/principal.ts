export type Role = 'clinician' | 'analyst' | 'patient' | 'partner' | 'auditor';

export type Purpose = 'treatment' | 'payment' | 'operations';

export interface Principal {
  sub: string;
  role: Role;
  tenantId: string;
  facilityIds?: string[];
  patientId?: string;
  scopes: string[];
  purposes: Purpose[];
}

export const ROLES: readonly Role[] = ['clinician', 'analyst', 'patient', 'partner', 'auditor'];

export const ROLE_SCOPES: Record<Role, readonly string[]> = {
  clinician: [
    'user/Patient.read',
    'user/Observation.read',
    'user/Condition.read',
    'user/Encounter.read',
    'user/Task.read',
    'user/Summary.read',
    'user/Risk.read',
    'user/Assessment.write',
    'user/Task.write',
  ],
  analyst: ['user/Metric.read', 'user/Analytics.query'],
  patient: [
    'patient/Patient.read',
    'patient/Observation.read',
    'patient/Condition.read',
    'patient/Encounter.read',
    'patient/Task.read',
    'patient/Summary.read',
    'patient/Risk.read',
  ],
  partner: [
    'system/Patient.read',
    'system/Observation.read',
    'system/Condition.read',
    'system/Encounter.read',
    'system/Task.read',
  ],
  auditor: ['user/Audit.read'],
};

const ROLE_PURPOSES: Record<Role, readonly Purpose[]> = {
  clinician: ['treatment'],
  analyst: ['operations'],
  patient: ['treatment'],
  partner: ['payment', 'operations'],
  auditor: ['operations'],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function purposesFor(role: Role): Purpose[] {
  return [...ROLE_PURPOSES[role]];
}

export function fhirReadScope(role: Role, resourceType: string): string {
  const level = role === 'patient' ? 'patient' : role === 'partner' ? 'system' : 'user';
  return `${level}/${resourceType}.read`;
}
