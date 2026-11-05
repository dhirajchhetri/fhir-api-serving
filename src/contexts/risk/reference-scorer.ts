import { RiskFeatures } from './features';

export type RiskBand = 'low' | 'moderate' | 'high';

export interface ScoreResult {
  score: number;
  band: RiskBand;
  modelVersion: string;
}

export const REFERENCE_MODEL_VERSION = 'reference-heuristic-0.1.0';

export const DECISION_SUPPORT_DISCLAIMER =
  'This score is decision support for a clinician. It does not start, stop, or change care on its own.';

/**
 * Deterministic stand-in for the SageMaker endpoint. Same feature contract,
 * fixed weights, no learned parameters. Useful for local runs and tests.
 */
export function referenceScore(features: RiskFeatures): ScoreResult {
  const areaTerm = features.areaChangeRatio <= -0.4 ? 0 : features.areaChangeRatio >= 0 ? 1.4 : 0.8;
  const comorbidity = Math.min(Math.max(features.comorbidityCount, 0), 4) * 0.25;
  const missedVisits = 1 - clamp(features.visitAdherence, 0, 1);
  const depth = Math.min(Math.max(features.depthCm, 0), 3) / 3;
  const offloading = features.offloading ? 0 : 0.3;
  const linear = -1.2 + 1.1 * areaTerm + 0.9 * comorbidity + 0.8 * missedVisits + 0.6 * depth + offloading;
  const score = round4(1 / (1 + Math.exp(-linear)));
  return { score, band: bandFor(score), modelVersion: REFERENCE_MODEL_VERSION };
}

export function bandFor(score: number): RiskBand {
  if (score < 0.33) return 'low';
  if (score < 0.66) return 'moderate';
  return 'high';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface RiskScorer {
  readonly modelVersion: string;
  score(features: RiskFeatures): Promise<ScoreResult>;
}

export class ReferenceRiskScorer implements RiskScorer {
  readonly modelVersion = REFERENCE_MODEL_VERSION;

  async score(features: RiskFeatures): Promise<ScoreResult> {
    return referenceScore(features);
  }
}
