const PHI_KEYS = new Set([
  'name',
  'family',
  'given',
  'birthdate',
  'birthDate',
  'address',
  'telecom',
  'identifier',
  'mrn',
  'familyName',
  'givenName',
  'text',
]);

const MRN = /\bSYN-\d{4}\b/g;

export function redactPhi<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PHI_KEYS.has(key) ? '[redacted]' : walk(inner);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(MRN, '[redacted-mrn]');
  }
  return value;
}
