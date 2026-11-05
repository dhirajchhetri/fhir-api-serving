import { sigV4HealthLakeHttp } from '../../src/contexts/clinical-interop/healthlake-fhir-store';
import { resourcesForAssessment } from '../../src/contexts/clinical-interop/fhir-mapper';
import { WoundAssessedPayload } from '../../src/domain/events';
import { WoundState } from '../../src/contexts/patient-care/model';

export interface MapperDetail {
  tenantId: string;
  payload: WoundAssessedPayload;
  wound: WoundState;
}

export function resourcesFromDetail(detail: MapperDetail) {
  return resourcesForAssessment(detail.wound, detail.payload);
}

/**
 * EventBridge target. Maps a wound assessment onto FHIR resources and, when
 * FHIR_DATASTORE_ENDPOINT is set, PUTs them to HealthLake with SigV4.
 */
export async function handler(event: { detail: MapperDetail }): Promise<{ resourceIds: string[] }> {
  const resources = resourcesFromDetail(event.detail);
  const endpoint = process.env.FHIR_DATASTORE_ENDPOINT;
  if (endpoint) {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const http = await sigV4HealthLakeHttp(region);
    for (const resource of resources) {
      const response = await http.request(`${endpoint.replace(/\/$/, '')}/${resource.resourceType}/${resource.id}`, {
        method: 'PUT',
        body: JSON.stringify(resource),
      });
      if (response.status >= 300) {
        throw new Error(`fhir put failed with status ${response.status}`);
      }
    }
  }
  return { resourceIds: resources.map((resource) => `${resource.resourceType}/${resource.id}`) };
}
