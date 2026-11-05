import { FhirResource, ResourceIndex } from './fhir-types';

export interface FhirStore {
  upsert(resource: FhirResource, index: ResourceIndex): Promise<FhirResource>;
  read(tenantId: string, resourceType: string, id: string): Promise<FhirResource | undefined>;
  search(tenantId: string, resourceType: string, params: Record<string, string>): Promise<FhirResource[]>;
  indexOf(tenantId: string, resourceType: string, id: string): ResourceIndex | undefined;
}
