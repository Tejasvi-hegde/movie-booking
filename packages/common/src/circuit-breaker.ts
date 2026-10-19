export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(readonly target: string) {
    super(`Circuit for ${target} is open`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  failureThreshold?: number;
  /** How long to stay OPEN before letting one trial request through. */
  resetTimeoutMs?: number;
  now?: () => number;
}

/**
 * Classic three-state circuit breaker.
 *
 * CLOSED    → calls flow; consecutive failures are counted.
 * OPEN      → calls fail fast (no waiting on a dead dependency, no pile-up of hung requests).
 * HALF_OPEN → after the cool-down one trial call is allowed; success closes, failure re-opens.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    readonly target: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get currentState(): CircuitState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.resetTimeoutMs) return 'HALF_OPEN';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    const state = this.currentState;
    if (state === 'OPEN') throw new CircuitOpenError(this.target);
    if (state === 'HALF_OPEN') {
      if (this.trialInFlight) throw new CircuitOpenError(this.target);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (isFailure(err)) this.onFailure();
      else this.onSuccess(); // e.g. a 404 means the dependency is healthy
      throw err;
    } finally {
      if (state === 'HALF_OPEN') this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.state = 'CLOSED';
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    if (this.currentState === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }
}
