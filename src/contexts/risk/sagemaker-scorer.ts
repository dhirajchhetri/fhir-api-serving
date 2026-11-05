import { InvokeEndpointCommand, SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { DomainError } from '../../domain/errors';
import { RiskFeatures } from './features';
import { bandFor, RiskScorer, ScoreResult } from './reference-scorer';

export class SageMakerRiskScorer implements RiskScorer {
  readonly modelVersion: string;

  constructor(
    private readonly invoke: (body: string) => Promise<string>,
    endpointName: string,
    private readonly breaker = new CircuitBreaker(3, 30_000),
  ) {
    this.modelVersion = endpointName;
  }

  async score(features: RiskFeatures): Promise<ScoreResult> {
    return this.breaker.exec(async () => {
      const raw = await this.invoke(JSON.stringify({ features }));
      const parsed = JSON.parse(raw) as { score?: unknown; modelVersion?: unknown };
      if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
        throw new DomainError('risk endpoint returned an unusable score', 'unavailable', 503);
      }
      const modelVersion = typeof parsed.modelVersion === 'string' ? parsed.modelVersion : this.modelVersion;
      return { score: parsed.score, band: bandFor(parsed.score), modelVersion };
    });
  }
}

export function sageMakerInvoke(client: SageMakerRuntimeClient, endpointName: string): (body: string) => Promise<string> {
  return async (body: string) => {
    const response = await client.send(new InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: 'application/json',
      Accept: 'application/json',
      Body: Buffer.from(body),
    }));
    return Buffer.from(response.Body ?? []).toString('utf8');
  };
}
