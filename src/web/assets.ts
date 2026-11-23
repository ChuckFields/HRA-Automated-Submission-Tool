import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDED } from './embedded.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

/** Static dashboard files: embedded strings in the packaged exe, read from ./public in dev. */
export function getAsset(name: string): { body: string; type: string } | null {
  const ext = path.extname(name);
  const type = TYPES[ext];
  if (!type) return null;
  if (EMBEDDED[name] !== undefined) return { body: EMBEDDED[name], type };
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return null;
  return { body: fs.readFileSync(file, 'utf8'), type };
}
