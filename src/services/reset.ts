import fs from 'node:fs';
import { closeDb, db } from '../db/db.js';
import { ensureDataDirs, paths } from '../util/paths.js';

/**
 * Wipe everything the app stored on this computer: database, encrypted logins, EOB PDFs, browser sessions,
 * screenshots and traces. Returns the paths it could not remove (a browser still holding its profile, say).
 */
export function resetAllData(): { removed: string[]; failed: string[] } {
  closeDb();
  const removed: string[] = [];
  const failed: string[] = [];
  const files = [paths.db, `${paths.db}-wal`, `${paths.db}-shm`, paths.masterKey, paths.credentials];
  const dirs = [paths.eobs, paths.screenshots, paths.traces, paths.discovery, paths.profile('ibx'), paths.profile('summit')];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        fs.rmSync(f, { force: true });
        removed.push(f);
      }
    } catch (err) {
      failed.push(`${f}: ${(err as Error).message}`);
    }
  }
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
        removed.push(d);
      }
    } catch (err) {
      failed.push(`${d}: ${(err as Error).message}`);
    }
  }
  ensureDataDirs();
  db(); // fresh, empty database
  return { removed, failed };
}
