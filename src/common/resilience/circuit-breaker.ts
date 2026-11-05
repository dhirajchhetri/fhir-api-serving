import { DomainError } from '../../domain/errors';

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get open(): boolean {
    return this.openedAt !== null && this.now() - this.openedAt < this.resetMs;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openedAt !== null && this.now() - this.openedAt >= this.resetMs) {
      this.openedAt = null;
      this.failures = 0;
    }
    if (this.open) {
      throw new DomainError('dependency circuit is open', 'unavailable', 503);
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.threshold) {
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}
