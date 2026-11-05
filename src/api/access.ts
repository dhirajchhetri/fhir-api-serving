import { AuditLog } from '../common/audit/audit-log';
import { fhirReadScope, Principal, Purpose } from '../common/auth/principal';
import { Cache } from '../common/cache/cache';
import { IdempotencyStore } from '../common/idempotency';
import { DomainError, AuthzError } from '../domain/errors';
import { FhirStore } from '../contexts/clinical-interop/fhir-store';
import { isFhirType } from '../contexts/clinical-interop/codes';
import { FhirResource } from '../contexts/clinical-interop/fhir-types';
import { PatientCareService } from '../contexts/patient-care/service';
import { PatientCareRepository } from '../contexts/patient-care/repository';
import { MEASUREMENT_CODES, NewAssessment, TissueType } from '../contexts/patient-care/model';
import { TaskingService } from '../contexts/tasking/service';
import { TaskRepository } from '../contexts/tasking/service';
import { RiskService } from '../contexts/risk/risk.service';
import { DECISION_SUPPORT_DISCLAIMER } from '../contexts/risk/reference-scorer';

const TISSUES: TissueType[] = ['granulation', 'slough', 'eschar', 'epithelial'];

export function requirePurpose(principal: Principal, header: string | undefined): Purpose {
  if (!header) throw new DomainError('X-Purpose-Of-Use header is required', 'purpose_required', 400);
  const purpose = header.toLowerCase();
  if (purpose !== 'treatment' && purpose !== 'payment' && purpose !== 'operations') {
    throw new DomainError('purpose of use is not recognised', 'purpose_required', 400);
  }
  if (!principal.purposes.includes(purpose)) {
    throw new AuthzError('purpose of use is not allowed for this role');
  }
  return purpose;
}

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new AuthzError(`missing scope ${scope}`);
}

function assertTenant(principal: Principal, tenantId: string): void {
  if (principal.tenantId !== tenantId) throw new AuthzError('tenant mismatch');
}

export class FhirReadService {
  constructor(
    private readonly store: FhirStore,
    private readonly audit: AuditLog,
    private readonly tenantId: string,
  ) {}

  capability(): Record<string, unknown> {
    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: '2026-11-05',
      kind: 'instance',
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [{
        mode: 'server',
        resource: ['Patient', 'Observation', 'Condition', 'Encounter', 'Task'].map((type) => ({
          type,
          interaction: [{ code: 'read' }, { code: 'search-type' }],
        })),
      }],
    };
  }

  async read(principal: Principal, purposeHeader: string | undefined, resourceType: string, id: string): Promise<FhirResource> {
    const purpose = requirePurpose(principal, purposeHeader);
    assertTenant(principal, this.tenantId);
    if (!isFhirType(resourceType)) throw new DomainError(`unsupported resource ${resourceType}`, 'not_found', 404);
    requireScope(principal, fhirReadScope(principal.role, resourceType));
    const resource = await this.store.read(this.tenantId, resourceType, id);
    if (!resource) {
      await this.audit.record(entry(principal, purpose, 'read', resourceType, [], 'deny', []));
      throw new DomainError('resource not found', 'not_found', 404);
    }
    if (!this.canSee(principal, resourceType, id)) {
      await this.audit.record(entry(principal, purpose, 'read', resourceType, [id], 'deny', []));
      throw new AuthzError('record is outside your scope');
    }
    await this.audit.record(entry(principal, purpose, 'read', resourceType, [id], 'allow', []));
    return resource;
  }

  async search(
    principal: Principal,
    purposeHeader: string | undefined,
    resourceType: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const purpose = requirePurpose(principal, purposeHeader);
    assertTenant(principal, this.tenantId);
    if (!isFhirType(resourceType)) throw new DomainError(`unsupported resource ${resourceType}`, 'not_found', 404);
    requireScope(principal, fhirReadScope(principal.role, resourceType));
    const queryKeys = Object.keys(params).filter((key) => key !== '_count');
    const found = await this.store.search(this.tenantId, resourceType, params);
    const visible = found.filter((resource) => this.canSee(principal, resource.resourceType, resource.id));
    await this.audit.record(entry(
      principal,
      purpose,
      'search',
      resourceType,
      visible.map((resource) => resource.id),
      'allow',
      queryKeys,
    ));
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      total: visible.length,
      entry: visible.map((resource) => ({
        fullUrl: `urn:uuid:${resource.resourceType}/${resource.id}`,
        resource,
      })),
    };
  }

  private canSee(principal: Principal, resourceType: string, id: string): boolean {
    const index = this.store.indexOf(this.tenantId, resourceType, id);
    if (!index) return false;
    if (principal.role === 'patient') return index.patientId === principal.patientId || id === principal.patientId;
    if (principal.role === 'clinician') {
      return Boolean(index.facilityId && principal.facilityIds?.includes(index.facilityId));
    }
    return principal.role === 'partner';
  }
}

export class ClinicalService {
  constructor(
    private readonly patients: PatientCareRepository,
    private readonly patientCare: PatientCareService,
    private readonly tasks: TaskRepository,
    private readonly tasking: TaskingService,
    private readonly scores: RiskService,
    private readonly audit: AuditLog,
    private readonly cache: Cache,
    private readonly idempotency: IdempotencyStore,
    private readonly tenantId: string,
  ) {}

  async summary(principal: Principal, purposeHeader: string | undefined, patientId: string): Promise<Record<string, unknown>> {
    const purpose = requirePurpose(principal, purposeHeader);
    requireScope(principal, principal.role === 'patient' ? 'patient/Summary.read' : 'user/Summary.read');
    const patient = this.patients.getPatient(this.tenantId, patientId);
    if (!patient) throw new DomainError('patient not found', 'not_found', 404);
    this.assertPatientAccess(principal, patient.id, patient.facilityId);
    const cacheKey = `summary:${this.tenantId}:${patientId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      await this.audit.record(entry(principal, purpose, 'read', 'PatientSummary', [patientId], 'allow', ['cache']));
      return JSON.parse(cached) as Record<string, unknown>;
    }
    const wounds = this.patients.listWoundsByPatient(this.tenantId, patientId).map((wound) => {
      const snapshot = wound.snapshot;
      const latest = snapshot.assessments[snapshot.assessments.length - 1];
      const area = latest?.measurements.find((measurement) => measurement.code === 'area-cm2')?.value;
      const score = this.scores.latest(this.tenantId, snapshot.id);
      return {
        id: snapshot.id,
        woundType: snapshot.woundType,
        status: snapshot.status,
        latestAreaCm2: area ?? null,
        latestRiskScore: score?.score ?? null,
        latestRiskBand: score?.band ?? null,
      };
    });
    const openTasks = this.tasks.list(this.tenantId).filter((task) => task.patientId === patientId && task.status === 'open');
    const body = {
      patientId: patient.id,
      facilityId: patient.facilityId,
      givenName: patient.givenName,
      familyName: patient.familyName,
      openWoundCount: wounds.filter((wound) => wound.status === 'open').length,
      openTaskCount: openTasks.length,
      wounds,
      synthetic: true,
    };
    await this.cache.set(cacheKey, JSON.stringify(body), 60);
    await this.audit.record(entry(principal, purpose, 'read', 'PatientSummary', [patientId], 'allow', []));
    return body;
  }

  async recordAssessment(
    principal: Principal,
    purposeHeader: string | undefined,
    woundId: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ assessmentId: string }> {
    const purpose = requirePurpose(principal, purposeHeader);
    requireScope(principal, 'user/Assessment.write');
    const wound = this.patients.getWound(this.tenantId, woundId);
    if (!wound) throw new DomainError('wound not found', 'not_found', 404);
    this.assertPatientAccess(principal, wound.snapshot.patientId, wound.snapshot.facilityId);
    const storeKey = idempotencyKey ? `${principal.sub}:${idempotencyKey}` : undefined;
    if (storeKey) {
      const previous = await this.idempotency.get(storeKey);
      if (previous) return JSON.parse(previous) as { assessmentId: string };
    }
    const input = parseAssessment(body, principal.sub);
    const result = await this.patientCare.recordAssessment(this.tenantId, woundId, input);
    if (storeKey) await this.idempotency.putIfAbsent(storeKey, JSON.stringify(result));
    await this.audit.record(entry(principal, purpose, 'create', 'Assessment', [result.assessmentId], 'allow', []));
    return result;
  }

  async listTasks(principal: Principal, purposeHeader: string | undefined, facilityId?: string): Promise<{ tasks: unknown[] }> {
    const purpose = requirePurpose(principal, purposeHeader);
    requireScope(principal, principal.role === 'patient' ? 'patient/Task.read' : 'user/Task.read');
    let tasks = this.tasks.list(this.tenantId);
    if (principal.role === 'patient') {
      tasks = tasks.filter((task) => task.patientId === principal.patientId);
    } else if (principal.role === 'clinician') {
      tasks = tasks.filter((task) => principal.facilityIds?.includes(task.facilityId));
    }
    if (facilityId) {
      if (principal.role === 'clinician' && !principal.facilityIds?.includes(facilityId)) {
        throw new AuthzError('facility is outside your scope');
      }
      tasks = tasks.filter((task) => task.facilityId === facilityId);
    }
    await this.audit.record(entry(principal, purpose, 'search', 'Task', tasks.map((task) => task.id), 'allow', facilityId ? ['facilityId'] : []));
    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        patientId: task.patientId,
        woundId: task.woundId,
        facilityId: task.facilityId,
        clinicianId: task.clinicianId,
        taskType: task.taskType,
        status: task.status,
        dueDate: task.dueDate,
      })),
    };
  }

  async completeTask(principal: Principal, purposeHeader: string | undefined, taskId: string, completedAt?: string): Promise<unknown> {
    requirePurpose(principal, purposeHeader);
    requireScope(principal, 'user/Task.write');
    const task = this.tasks.get(this.tenantId, taskId);
    if (!task) throw new DomainError('task not found', 'not_found', 404);
    this.assertPatientAccess(principal, task.patientId, task.facilityId);
    const updated = await this.tasking.complete(this.tenantId, taskId, completedAt ?? new Date().toISOString());
    return { id: updated.id, status: updated.status, completedAt: updated.completedAt };
  }

  async risk(principal: Principal, purposeHeader: string | undefined, patientId: string, woundId: string): Promise<Record<string, unknown>> {
    const purpose = requirePurpose(principal, purposeHeader);
    requireScope(principal, principal.role === 'patient' ? 'patient/Risk.read' : 'user/Risk.read');
    const wound = this.patients.getWound(this.tenantId, woundId);
    if (!wound || wound.snapshot.patientId !== patientId) throw new DomainError('wound not found', 'not_found', 404);
    this.assertPatientAccess(principal, patientId, wound.snapshot.facilityId);
    const score = this.scores.latest(this.tenantId, woundId);
    if (!score) throw new DomainError('risk score not found', 'not_found', 404);
    await this.audit.record(entry(principal, purpose, 'read', 'RiskScore', [woundId], 'allow', []));
    return {
      woundId,
      patientId,
      score: score.score,
      band: score.band,
      modelVersion: score.modelVersion,
      computedAt: score.computedAt,
      decisionSupportOnly: true,
      disclaimer: DECISION_SUPPORT_DISCLAIMER,
      features: {
        woundType: score.features.woundType,
        areaChangeRatio: score.features.areaChangeRatio,
        comorbidityCount: score.features.comorbidityCount,
        visitAdherence: score.features.visitAdherence,
        depthCm: score.features.depthCm,
        offloading: score.features.offloading,
      },
    };
  }

  private assertPatientAccess(principal: Principal, patientId: string, facilityId: string): void {
    if (principal.role === 'patient' && principal.patientId !== patientId) {
      throw new AuthzError('patient scope does not include this record');
    }
    if (principal.role === 'clinician' && !principal.facilityIds?.includes(facilityId)) {
      throw new AuthzError('facility is outside your scope');
    }
  }
}

function entry(
  principal: Principal,
  purpose: string,
  action: string,
  resourceType: string,
  resourceIds: string[],
  outcome: 'allow' | 'deny',
  queryKeys: string[],
) {
  return {
    actorSub: principal.sub,
    actorRole: principal.role,
    tenantId: principal.tenantId,
    action,
    resourceType,
    resourceIds,
    purpose,
    outcome,
    queryKeys,
  };
}

function parseAssessment(body: unknown, clinicianId: string): NewAssessment {
  if (!body || typeof body !== 'object') throw new DomainError('assessment body is required');
  const record = body as Record<string, unknown>;
  const tissueType = record.tissueType;
  if (typeof tissueType !== 'string' || !TISSUES.includes(tissueType as TissueType)) {
    throw new DomainError('tissueType is not recognised');
  }
  if (typeof record.assessedAt !== 'string') throw new DomainError('assessedAt is required');
  if (!Array.isArray(record.measurements)) throw new DomainError('measurements are required');
  const measurements = record.measurements.map((item) => {
    if (!item || typeof item !== 'object') throw new DomainError('measurement is invalid');
    const measurement = item as Record<string, unknown>;
    const code = measurement.code;
    if (typeof code !== 'string' || !MEASUREMENT_CODES.includes(code as NewAssessment['measurements'][number]['code'])) {
      throw new DomainError('measurement code is not recognised');
    }
    if (typeof measurement.value !== 'number') throw new DomainError('measurement value must be a number');
    const unit = typeof measurement.unit === 'string' ? measurement.unit : code.endsWith('cm2') ? 'cm2' : 'cm';
    return { code: code as NewAssessment['measurements'][number]['code'], value: measurement.value, unit };
  });
  return {
    assessedAt: record.assessedAt,
    clinicianId,
    tissueType: tissueType as TissueType,
    offloading: Boolean(record.offloading),
    closed: Boolean(record.closed),
    measurements,
  };
}
