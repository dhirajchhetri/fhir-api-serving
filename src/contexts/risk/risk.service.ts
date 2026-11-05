import { randomUUID } from 'crypto';
import { InProcessEventBus } from '../../domain/event-bus';
import { domainEvent, DomainEvent, RiskScoreComputedPayload, WoundAssessedPayload } from '../../domain/events';
import { DomainError } from '../../domain/errors';
import { PatientCareRepository } from '../patient-care/repository';
import { TaskRepository } from '../tasking/service';
import { extractFeatures, RiskFeatures } from './features';
import { DECISION_SUPPORT_DISCLAIMER, RiskScorer } from './reference-scorer';

export interface StoredRiskScore {
  id: string;
  tenantId: string;
  patientId: string;
  woundId: string;
  score: number;
  band: 'low' | 'moderate' | 'high';
  modelVersion: string;
  computedAt: string;
  features: RiskFeatures;
  decisionSupportOnly: true;
  disclaimer: string;
}

export class RiskService {
  private readonly history: StoredRiskScore[] = [];

  constructor(
    private readonly scorer: RiskScorer,
    private readonly patients: PatientCareRepository,
    private readonly tasks: TaskRepository,
    private readonly bus: InProcessEventBus,
    private readonly ids: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async onWoundAssessed(event: DomainEvent<WoundAssessedPayload>): Promise<StoredRiskScore> {
    return this.scoreWound(event.tenantId, event.aggregateId);
  }

  async scoreAll(tenantId: string): Promise<void> {
    for (const wound of this.patients.listWounds(tenantId)) {
      if (wound.snapshot.assessments.length === 0) continue;
      await this.scoreWound(tenantId, wound.snapshot.id);
    }
  }

  async scoreWound(tenantId: string, woundId: string): Promise<StoredRiskScore> {
    const wound = this.patients.getWound(tenantId, woundId);
    if (!wound) throw new DomainError('wound not found', 'not_found', 404);
    const snapshot = wound.snapshot;
    if (snapshot.assessments.length === 0) throw new DomainError('wound has no assessment');
    const patient = this.patients.getPatient(tenantId, snapshot.patientId);
    const features = extractFeatures(snapshot, patient?.conditions.length ?? 0, this.tasks.list(tenantId));
    const result = await this.scorer.score(features);
    const record: StoredRiskScore = {
      id: this.ids(),
      tenantId,
      patientId: snapshot.patientId,
      woundId,
      score: result.score,
      band: result.band,
      modelVersion: result.modelVersion,
      computedAt: this.now(),
      features,
      decisionSupportOnly: true,
      disclaimer: DECISION_SUPPORT_DISCLAIMER,
    };
    this.history.push(record);
    const payload: RiskScoreComputedPayload = {
      patientId: record.patientId,
      woundId,
      score: record.score,
      band: record.band,
      modelVersion: record.modelVersion,
    };
    await this.bus.publish([
      domainEvent('RiskScoreComputed', {
        id: this.ids(),
        occurredAt: record.computedAt,
        tenantId,
        aggregateId: woundId,
        payload,
      }),
    ]);
    return record;
  }

  latest(tenantId: string, woundId: string): StoredRiskScore | undefined {
    return [...this.history].reverse().find((score) => score.tenantId === tenantId && score.woundId === woundId);
  }
}
