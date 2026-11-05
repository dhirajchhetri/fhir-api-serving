import { FhirStore } from './fhir-store';
import { FhirResource, ResourceIndex } from './fhir-types';

interface Stored {
  resource: FhirResource;
  index: ResourceIndex;
}

export class InMemoryFhirStore implements FhirStore {
  private readonly rows = new Map<string, Stored>();

  async upsert(resource: FhirResource, index: ResourceIndex): Promise<FhirResource> {
    const id = `${index.tenantId}/${resource.resourceType}/${resource.id}`;
    const previous = this.rows.get(id);
    const version = previous ? Number(previous.resource.meta?.versionId ?? '0') + 1 : 1;
    const stored: FhirResource = {
      ...resource,
      meta: {
        ...(resource.meta ?? {}),
        versionId: String(version),
        lastUpdated: new Date().toISOString(),
      },
    };
    this.rows.set(id, { resource: stored, index });
    return stored;
  }

  async read(tenantId: string, resourceType: string, id: string): Promise<FhirResource | undefined> {
    return this.rows.get(`${tenantId}/${resourceType}/${id}`)?.resource;
  }

  async search(tenantId: string, resourceType: string, params: Record<string, string>): Promise<FhirResource[]> {
    const count = Math.min(Number(params._count ?? 50) || 50, 200);
    const matches = [...this.rows.values()]
      .filter((row) => row.index.tenantId === tenantId && row.resource.resourceType === resourceType)
      .filter((row) => matchesParams(row.resource, params))
      .map((row) => row.resource);
    return matches.slice(0, count);
  }

  indexOf(tenantId: string, resourceType: string, id: string): ResourceIndex | undefined {
    return this.rows.get(`${tenantId}/${resourceType}/${id}`)?.index;
  }
}

function matchesParams(resource: FhirResource, params: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(params)) {
    if (key === '_count' || value === '') continue;
    if (key === '_id' && resource.id !== value) return false;
    if (key === 'identifier' && !identifiers(resource).includes(value)) return false;
    if (key === 'name' && !nameMatches(resource, value)) return false;
    if (key === 'patient' && patientRef(resource) !== normalizeRef(value)) return false;
    if (key === 'status' && statusOf(resource) !== value) return false;
    if (key === 'clinical-status' && clinicalStatus(resource) !== value) return false;
    if (key === 'category' && !codesIn(resource.category).includes(value)) return false;
    if (key === 'code' && !codesIn(resource.code).includes(value)) return false;
  }
  return true;
}

function identifiers(resource: FhirResource): string[] {
  const list = resource.identifier;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === 'object' && 'value' in item ? String(item.value) : ''))
    .filter(Boolean);
}

function nameMatches(resource: FhirResource, value: string): boolean {
  const needle = value.toLowerCase();
  const names = resource.name;
  if (!Array.isArray(names)) return false;
  return names.some((name) => {
    if (!name || typeof name !== 'object') return false;
    const record = name as { family?: string; given?: string[]; text?: string };
    const given = Array.isArray(record.given) ? record.given.join(' ') : '';
    const haystack = `${record.family ?? ''} ${given} ${record.text ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

function patientRef(resource: FhirResource): string | undefined {
  if (resource.resourceType === 'Patient') return `Patient/${resource.id}`;
  const subject = referenceOf(resource.subject) ?? referenceOf(resource.for);
  return subject;
}

function normalizeRef(value: string): string {
  return value.includes('/') ? value : `Patient/${value}`;
}

function referenceOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('reference' in value)) return undefined;
  const reference = (value as { reference?: unknown }).reference;
  return typeof reference === 'string' ? reference : undefined;
}

function statusOf(resource: FhirResource): string | undefined {
  return typeof resource.status === 'string' ? resource.status : undefined;
}

function clinicalStatus(resource: FhirResource): string | undefined {
  const codes = codesIn(resource.clinicalStatus);
  return codes[0];
}

function codesIn(value: unknown): string[] {
  if (!value) return [];
  const concepts = Array.isArray(value) ? value : [value];
  const codes: string[] = [];
  for (const concept of concepts) {
    if (!concept || typeof concept !== 'object' || !('coding' in concept)) continue;
    const coding = (concept as { coding?: unknown }).coding;
    if (!Array.isArray(coding)) continue;
    for (const entry of coding) {
      if (entry && typeof entry === 'object' && 'code' in entry && typeof entry.code === 'string') {
        codes.push(entry.code);
      }
    }
  }
  return codes;
}
