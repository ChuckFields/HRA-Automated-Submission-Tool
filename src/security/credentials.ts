import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ensureDataDirs, paths } from '../util/paths.js';

export interface PortalCredentials {
  username: string;
  password: string;
  /** Summit security questions: question text (lower-cased, trimmed) -> answer. */
  securityAnswers?: Record<string, string>;
}

export interface CredentialStore {
  ibx?: PortalCredentials;
  summit?: PortalCredentials;
}

const ALGO = 'aes-256-gcm';

function masterKey(): Buffer {
  ensureDataDirs();
  if (!fs.existsSync(paths.masterKey)) {
    fs.writeFileSync(paths.masterKey, randomBytes(32));
  }
  const key = fs.readFileSync(paths.masterKey);
  if (key.length !== 32) throw new Error('master.key is corrupt (expected 32 bytes)');
  return key;
}

function encrypt(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function loadCredentials(): CredentialStore {
  if (!fs.existsSync(paths.credentials)) return {};
  try {
    return JSON.parse(decrypt(fs.readFileSync(paths.credentials))) as CredentialStore;
  } catch (err) {
    throw new Error(`Could not decrypt credentials.enc: ${(err as Error).message}`);
  }
}

export function saveCredentials(portal: keyof CredentialStore, creds: PortalCredentials): void {
  const store = loadCredentials();
  const existing = store[portal];
  store[portal] = {
    username: creds.username,
    password: creds.password || existing?.password || '',
    securityAnswers: { ...(existing?.securityAnswers ?? {}), ...(creds.securityAnswers ?? {}) },
  };
  fs.writeFileSync(paths.credentials, encrypt(JSON.stringify(store)));
}

export function clearCredentials(portal: keyof CredentialStore): void {
  const store = loadCredentials();
  delete store[portal];
  fs.writeFileSync(paths.credentials, encrypt(JSON.stringify(store)));
}

/** Never returns secrets: only whether each portal has a username+password saved. */
export function credentialStatus(): { ibx: boolean; summit: boolean; ibxUser: string | null; summitUser: string | null } {
  const s = loadCredentials();
  return {
    ibx: Boolean(s.ibx?.username && s.ibx?.password),
    summit: Boolean(s.summit?.username && s.summit?.password),
    ibxUser: s.ibx?.username ?? null,
    summitUser: s.summit?.username ?? null,
  };
}

export function requireCredentials(portal: keyof CredentialStore): PortalCredentials {
  const c = loadCredentials()[portal];
  if (!c?.username || !c?.password) {
    throw new Error(`No ${portal.toUpperCase()} credentials saved. Open Settings and enter them first.`);
  }
  return c;
}
