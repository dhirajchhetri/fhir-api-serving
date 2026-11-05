import { PatientRecord, Wound, WoundState } from './model';

export interface PatientCareRepository {
  savePatient(patient: PatientRecord): void;
  getPatient(tenantId: string, id: string): PatientRecord | undefined;
  listPatients(tenantId: string): PatientRecord[];
  saveWound(wound: Wound): void;
  getWound(tenantId: string, id: string): Wound | undefined;
  listWounds(tenantId: string): Wound[];
  listWoundsByPatient(tenantId: string, patientId: string): Wound[];
}

export class InMemoryPatientCareRepository implements PatientCareRepository {
  private readonly patients = new Map<string, PatientRecord>();
  private readonly wounds = new Map<string, WoundState>();

  savePatient(patient: PatientRecord): void {
    this.patients.set(key(patient.tenantId, patient.id), { ...patient, conditions: [...patient.conditions] });
  }

  getPatient(tenantId: string, id: string): PatientRecord | undefined {
    const found = this.patients.get(key(tenantId, id));
    return found ? { ...found, conditions: [...found.conditions] } : undefined;
  }

  listPatients(tenantId: string): PatientRecord[] {
    return [...this.patients.values()].filter((patient) => patient.tenantId === tenantId);
  }

  saveWound(wound: Wound): void {
    const snapshot = wound.snapshot;
    this.wounds.set(key(snapshot.tenantId, snapshot.id), snapshot);
  }

  getWound(tenantId: string, id: string): Wound | undefined {
    const state = this.wounds.get(key(tenantId, id));
    return state ? Wound.rehydrate(state) : undefined;
  }

  listWounds(tenantId: string): Wound[] {
    return [...this.wounds.values()]
      .filter((wound) => wound.tenantId === tenantId)
      .map((state) => Wound.rehydrate(state));
  }

  listWoundsByPatient(tenantId: string, patientId: string): Wound[] {
    return this.listWounds(tenantId).filter((wound) => wound.snapshot.patientId === patientId);
  }
}

function key(tenantId: string, id: string): string {
  return `${tenantId}/${id}`;
}
