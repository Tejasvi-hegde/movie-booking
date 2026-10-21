import { AppError, ServiceUnavailableError } from './errors.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { HEADERS } from './http.js';

export class UpstreamError extends Error {
  constructor(status, body, target) {
    super(`${target} responded ${status}`);
    this.status = status;
    this.body = body;
    this.target = target;
    this.name = 'UpstreamError';
  }
}

/**
 * Service-to-service HTTP client: per-call timeout, retries with exponential backoff + jitter
 * (GET only — retrying a POST could repeat a side effect), and a circuit breaker per target.
 */
export class ServiceClient {
  constructor(opts) {
    this.opts = opts;
    this.breaker = new CircuitBreaker(opts.name);
    this.timeoutMs = opts.timeoutMs ?? 2_000;
    this.retries = opts.retries ?? 2;
  }

  async get(path, requestId) {
    return this.request('GET', path, undefined, requestId);
  }

  async post(path, body, requestId) {
    return this.request('POST', path, body, requestId);
  }

  async request(method, path, body, requestId) {
    const attempts = method === 'GET' ? this.retries + 1 : 1;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.breaker.exec(
          () => this.once(method, path, body, requestId),
          // 4xx are the caller's problem, not a sign the dependency is down.
          (err) => !(err instanceof UpstreamError && err.status < 500),
        );
      } catch (err) {
        lastErr = err;
        if (err instanceof CircuitOpenError) throw new ServiceUnavailableError(`${this.opts.name} is unavailable`);
        if (err instanceof UpstreamError && err.status < 500) throw err;
        if (attempt < attempts) {
          const backoff = 100 * 2 ** (attempt - 1) + Math.random() * 100;
          this.opts.logger.warn({ target: this.opts.name, path, attempt, err: err.message }, 'Upstream call failed, retrying');
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    this.opts.logger.error({ target: this.opts.name, path, err: lastErr }, 'Upstream call failed');
    throw new ServiceUnavailableError(`${this.opts.name} is unavailable`);
  }

  async once(method, path, body, requestId) {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [HEADERS.internalToken]: this.opts.internalToken,
        ...(requestId ? { [HEADERS.requestId]: requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new UpstreamError(res.status, json, this.opts.name);
    return json;
  }
}

/** Re-throw an upstream 4xx as our own error with the same status, so clients see a meaningful message. */
export function rethrowUpstream(err) {
  if (err instanceof UpstreamError) {
    const e = err.body?.error;
    throw new AppError(err.status, e?.code ?? 'UPSTREAM_ERROR', e?.message ?? err.message);
  }
  throw err;
}
