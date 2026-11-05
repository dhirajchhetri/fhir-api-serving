import aws4 from 'aws4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { FhirStore } from './fhir-store';
import { FhirResource, ResourceIndex } from './fhir-types';

export interface SignedHttp {
  request(url: string, init: { method: string; body?: string }): Promise<{ status: number; text: string }>;
}

/**
 * FHIR read/write against a HealthLake datastore endpoint.
 * Facility and patient indexes are kept beside the resource because
 * HealthLake search does not know our facility extension by itself.
 */
export class HealthLakeFhirStore implements FhirStore {
  private readonly index = new Map<string, ResourceIndex>();

  constructor(
    private readonly baseUrl: string,
    private readonly http: SignedHttp,
  ) {}

  async upsert(resource: FhirResource, meta: ResourceIndex): Promise<FhirResource> {
    const url = `${this.baseUrl}/${resource.resourceType}/${resource.id}`;
    const res = await this.http.request(url, { method: 'PUT', body: JSON.stringify(resource) });
    if (res.status >= 300) {
      throw new Error(`HealthLake upsert failed with status ${res.status}`);
    }
    const stored = res.text ? (JSON.parse(res.text) as FhirResource) : resource;
    this.index.set(`${meta.tenantId}/${resource.resourceType}/${resource.id}`, meta);
    return stored.id ? stored : resource;
  }

  async read(tenantId: string, resourceType: string, id: string): Promise<FhirResource | undefined> {
    if (!this.index.has(`${tenantId}/${resourceType}/${id}`)) return undefined;
    const res = await this.http.request(`${this.baseUrl}/${resourceType}/${id}`, { method: 'GET' });
    if (res.status === 404) return undefined;
    if (res.status >= 300) throw new Error(`HealthLake read failed with status ${res.status}`);
    return JSON.parse(res.text) as FhirResource;
  }

  async search(tenantId: string, resourceType: string, params: Record<string, string>): Promise<FhirResource[]> {
    const query = new URLSearchParams(params);
    const res = await this.http.request(`${this.baseUrl}/${resourceType}?${query.toString()}`, { method: 'GET' });
    if (res.status >= 300) throw new Error(`HealthLake search failed with status ${res.status}`);
    const bundle = JSON.parse(res.text) as { entry?: { resource: FhirResource }[] };
    const resources = (bundle.entry ?? []).map((entry) => entry.resource).filter(Boolean);
    return resources.filter((resource) => this.index.has(`${tenantId}/${resource.resourceType}/${resource.id}`));
  }

  indexOf(tenantId: string, resourceType: string, id: string): ResourceIndex | undefined {
    return this.index.get(`${tenantId}/${resourceType}/${id}`);
  }
}

export async function sigV4HealthLakeHttp(region: string): Promise<SignedHttp> {
  const credentials = await defaultProvider()();
  return {
    async request(url, init) {
      const parsed = new URL(url);
      const signed = aws4.sign(
        {
          host: parsed.host,
          path: `${parsed.pathname}${parsed.search}`,
          service: 'healthlake',
          region,
          method: init.method,
          body: init.body,
          headers: { 'content-type': 'application/fhir+json' },
        },
        {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      );
      const response = await fetch(`https://${signed.host}${signed.path}`, {
        method: init.method,
        headers: signed.headers as Record<string, string>,
        body: init.body,
      });
      return { status: response.status, text: await response.text() };
    },
  };
}
