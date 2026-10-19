import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and fails fast', async () => {
    let now = 0;
    const cb = new CircuitBreaker('svc', { failureThreshold: 3, resetTimeoutMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toThrow('boom');
    expect(cb.currentState).toBe('OPEN');

    let called = false;
    await expect(cb.exec(async () => ((called = true), 'x'))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('half-opens after the cool-down; success closes it', async () => {
    let now = 0;
    const cb = new CircuitBreaker('svc', { failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    await expect(cb.exec(fail)).rejects.toThrow();
    now = 1000;
    expect(cb.currentState).toBe('HALF_OPEN');
    await expect(cb.exec(ok)).resolves.toBe('ok');
    expect(cb.currentState).toBe('CLOSED');
  });

  it('a failed trial in half-open re-opens with a fresh cool-down', async () => {
    let now = 0;
    const cb = new CircuitBreaker('svc', { failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    await expect(cb.exec(fail)).rejects.toThrow();
    now = 1500;
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    expect(cb.currentState).toBe('OPEN');
    now = 2000; // only 500ms since re-open
    expect(cb.currentState).toBe('OPEN');
    now = 2500;
    expect(cb.currentState).toBe('HALF_OPEN');
  });

  it('does not count errors the caller marks as non-failures (e.g. 404s)', async () => {
    const cb = new CircuitBreaker('svc', { failureThreshold: 1 });
    await expect(cb.exec(fail, () => false)).rejects.toThrow();
    expect(cb.currentState).toBe('CLOSED');
  });
});
