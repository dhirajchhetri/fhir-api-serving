import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import jwt from 'jsonwebtoken';
import { DomainError } from '../../domain/errors';
import { isRole, Principal, purposesFor, ROLE_SCOPES, Role } from './principal';

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export function principalFromPayload(payload: JWTPayload | jwt.JwtPayload): Principal {
  const groups = readGroups(payload);
  const role = groups.find(isRole);
  if (!role) {
    throw new DomainError('token has no recognised role', 'unauthorized', 401);
  }
  const tenantId = readString(payload, 'custom:tenant_id') ?? readString(payload, 'tenant_id');
  if (!tenantId) {
    throw new DomainError('token is missing tenant_id', 'unauthorized', 401);
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) {
    throw new DomainError('token is missing sub', 'unauthorized', 401);
  }
  const facilityRaw = readString(payload, 'custom:facility_ids') ?? readString(payload, 'facility_ids');
  const facilityIds = facilityRaw
    ? facilityRaw.split(',').map((part) => part.trim()).filter(Boolean)
    : undefined;
  const patientId = readString(payload, 'custom:patient_id') ?? readString(payload, 'patient_id');
  return {
    sub,
    role,
    tenantId,
    facilityIds: role === 'clinician' ? facilityIds ?? [] : facilityIds,
    patientId,
    scopes: scopesFor(role, payload),
    purposes: purposesFor(role),
  };
}

function scopesFor(role: Role, payload: JWTPayload | jwt.JwtPayload): string[] {
  const allowed = new Set(ROLE_SCOPES[role]);
  const requested = readScopes(payload).filter((scope) => allowed.has(scope));
  if (requested.length > 0) return requested;
  return [...ROLE_SCOPES[role]];
}

function readGroups(payload: JWTPayload | jwt.JwtPayload): string[] {
  const groups = payload['cognito:groups'] ?? payload['roles'] ?? payload['role'];
  if (typeof groups === 'string') return [groups];
  if (Array.isArray(groups)) return groups.filter((item): item is string => typeof item === 'string');
  return [];
}

function readScopes(payload: JWTPayload | jwt.JwtPayload): string[] {
  const smart = payload['custom:smart_scopes'] ?? payload['smart_scopes'];
  const scope = payload['scope'];
  const raw = typeof smart === 'string' ? smart : typeof scope === 'string' && scope.includes('/') ? scope : '';
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function readString(payload: JWTPayload | jwt.JwtPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class PemTokenVerifier implements TokenVerifier {
  constructor(
    private readonly publicKeyPem: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  async verify(token: string): Promise<Principal> {
    try {
      const payload = jwt.verify(token, this.publicKeyPem, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
      });
      if (typeof payload === 'string') {
        throw new DomainError('unexpected token payload', 'unauthorized', 401);
      }
      return principalFromPayload(payload);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('invalid token', 'unauthorized', 401);
    }
  }
}

export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    jwksUri: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      });
      return principalFromPayload(payload);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('invalid token', 'unauthorized', 401);
    }
  }
}
