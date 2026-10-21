export class CircuitOpenError extends Error {
  constructor(target) {
    super(`Circuit for ${target} is open`);
    this.target = target;
    this.name = 'CircuitOpenError';
  }
}

/**
 * Classic three-state circuit breaker.
 *
 * CLOSED    → calls flow; consecutive failures are counted.
 * OPEN      → calls fail fast (no waiting on a dead dependency, no pile-up of hung requests).
 * HALF_OPEN → after the cool-down one trial call is allowed; success closes, failure re-opens.
 */
export class CircuitBreaker {
  state = 'CLOSED';
  failures = 0;
  openedAt = 0;
  trialInFlight = false;

  constructor(target, opts = {}) {
    this.target = target;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get currentState() {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.resetTimeoutMs) return 'HALF_OPEN';
    return this.state;
  }

  async exec(fn, isFailure = () => true) {
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

  onSuccess() {
    this.state = 'CLOSED';
    this.failures = 0;
  }

  onFailure() {
    this.failures++;
    if (this.currentState === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }
}
