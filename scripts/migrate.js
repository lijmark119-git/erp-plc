import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(__dirname, '../migrations');
const migrationFiles = fs.readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right));

export async function migrateDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(80) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        checksum TEXT NOT NULL,
        execution_order INTEGER NOT NULL
      )
    `);

    for (const [index, fileName] of migrationFiles.entries()) {
      const sql = fs.readFileSync(path.join(migrationsDirectory, fileName), 'utf8');
      const checksum = createHash(sql);
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        [fileName],
      );

      if (existing.rowCount > 0) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum changed: ${fileName}`);
        }
        continue;
      }

      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (id, checksum, execution_order) VALUES ($1, $2, $3)',
        [fileName, checksum, index + 1],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createDatabasePool();
  try {
    await migrateDatabase(pool);
    console.log(`Applied ${migrationFiles.length} migration(s).`);
  } finally {
    await pool.end();
  }
}
