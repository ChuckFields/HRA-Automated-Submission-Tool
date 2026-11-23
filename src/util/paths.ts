import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function detectSea(): boolean {
  try {
    // Available in Node >= 20.12. In a Single Executable Application this returns true.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

export const IS_SEA = detectSea();

function resolveDataDir(): string {
  if (process.env.HRA_DATA_DIR) return path.resolve(process.env.HRA_DATA_DIR);
  if (IS_SEA) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'HRA-Submission-Tool');
  }
  return path.resolve(process.cwd(), 'data');
}

export const DATA_DIR = resolveDataDir();

export const paths = {
  data: DATA_DIR,
  db: path.join(DATA_DIR, 'hra.sqlite'),
  masterKey: path.join(DATA_DIR, 'master.key'),
  credentials: path.join(DATA_DIR, 'credentials.enc'),
  eobs: path.join(DATA_DIR, 'eobs'),
  screenshots: path.join(DATA_DIR, 'screenshots'),
  traces: path.join(DATA_DIR, 'traces'),
  discovery: path.join(DATA_DIR, 'discovery'),
  profile: (portal: 'ibx' | 'summit') => path.join(DATA_DIR, `profile-${portal}`),
};

export function ensureDataDirs(): void {
  for (const dir of [paths.data, paths.eobs, paths.screenshots, paths.traces, paths.discovery]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Make a string safe to use as a file or folder name on Windows. */
export function safeName(input: string): string {
  return input.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'unknown';
}
