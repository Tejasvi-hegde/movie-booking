import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Repository functions take a `db` argument that is anything that can run a query:
 * the pool, or a client inside a transaction (so the same function works in both).
 * @typedef {pg.Pool | pg.PoolClient} Queryable
 */

// Return BIGINT/NUMERIC as numbers. Safe here: money is stored as integer paise, well below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(connectionString, max = 10) {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

/**
 * Runs `fn` inside BEGIN/COMMIT, rolling back on any error.
 * Retries serialization failures and deadlocks, which Postgres expects callers to retry.
 */
export async function withTransaction(pool, fn, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = err.code;
      const retryable = code === '40001' || code === '40P01';
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export function isUniqueViolation(err, constraint) {
  const e = err;
  return e.code === '23505' && (!constraint || e.constraint === constraint);
}

/**
 * Minimal forward-only migration runner. Applies *.sql files in name order, once each.
 * An advisory lock makes it safe when several replicas start at the same time.
 */
export async function runMigrations(pool, dir, logger) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727272)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
}

/** Creates the database if it does not exist (handy for local dev without docker init scripts). */
export async function ensureDatabase(connectionString) {
  const url = new URL(connectionString);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Refusing to create database with unsafe name: ${dbName}`);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${dbName}"`).catch((err) => {
        if (err.code !== '42P04') throw err; // created concurrently
      });
    }
  } finally {
    await admin.end();
  }
}
