export interface FhirResource {
  resourceType: string;
  id: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    tag?: { system: string; code: string }[];
  };
  [key: string]: unknown;
}

export interface ResourceIndex {
  tenantId: string;
  patientId?: string;
  facilityId?: string;
}
