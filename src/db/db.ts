import { DatabaseSync } from 'node:sqlite';
import { ensureDataDirs, paths } from '../util/paths.js';
import { SCHEMA_SQL } from './schemaText.js';

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (!instance) {
    ensureDataDirs();
    instance = new DatabaseSync(paths.db);
    instance.exec(SCHEMA_SQL);
    migrate(instance);
  }
  return instance;
}

export function closeDb(): void {
  try {
    instance?.close();
  } catch {
    /* already closed */
  }
  instance = null;
}

/** Columns added after the first release; safe to run on every start. */
function migrate(d: DatabaseSync): void {
  const cols = (d.prepare('PRAGMA table_info(submissions)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('benefit')) d.exec("ALTER TABLE submissions ADD COLUMN benefit TEXT NOT NULL DEFAULT 'deductible'");
  if (!cols.includes('approved_cents')) d.exec('ALTER TABLE submissions ADD COLUMN approved_cents INTEGER');
  if (!cols.includes('payment_method')) d.exec('ALTER TABLE submissions ADD COLUMN payment_method TEXT');
}

/** For tests: open an in-memory database instead of the file. */
export function useInMemoryDb(): DatabaseSync {
  instance = new DatabaseSync(':memory:');
  instance.exec(SCHEMA_SQL);
  return instance;
}
