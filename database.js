import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEnvironmentFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const separator = trimmed.indexOf('=');
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
}

export function createDatabasePool() {
  loadEnvironmentFile();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured. Copy .env.example to .env.');
  }

  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('sslmode', 'verify-full');

  return new pg.Pool({
    connectionString: databaseUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function checkDatabaseConnection(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT current_database(), current_user, version()');
    return {
      database: result.rows[0].current_database,
      user: result.rows[0].current_user,
      version: result.rows[0].version,
    };
  } finally {
    client.release();
  }
}
