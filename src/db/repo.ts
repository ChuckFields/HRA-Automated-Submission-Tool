import { db } from './db.js';
import { nowIso } from '../util/dates.js';
import { canonicalJson, sha256 } from '../util/hash.js';
import type {
  Benefit,
  Claim,
  EobFile,
  JobKind,
  JobRun,
  JobStatus,
  Member,
  NormalizedClaim,
  Settings,
  Submission,
  SubmissionStatus,
  SummitActivity,
} from '../types.js';

type Row = Record<string, unknown>;

// ---------- settings ----------

export const SETTINGS_DEFAULTS: Settings = {
  plan_option: null,
  coverage_tier: null,
  plan_year: 2026,
  plan_source: null,
  summit_base_url: 'https://alera-bds.summitfor.me',
  summit_claimants: [],
  ibx_member_url: 'https://member.ibx.com/mdx/csportal/',
  last_ibx_fetch_at: null,
  last_summit_sync_at: null,
  last_ibx_fetch_claims: null,
  last_ibx_fetch_pdfs: null,
  last_summit_sync_transactions: null,
};

export function getSettings(): Settings {
  const rows = db().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out as unknown as Settings;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const stmt = db().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTINGS_DEFAULTS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

export function isSetupComplete(s = getSettings()): boolean {
  return Boolean(s.plan_option && s.coverage_tier);
}

// ---------- members ----------

export function listMembers(): Member[] {
  return db().prepare('SELECT * FROM members ORDER BY id').all() as unknown as Member[];
}

export function upsertMember(m: { ibx_member_id: string; display_name: string; relationship: string }): Member {
  db()
    .prepare(
      `INSERT INTO members(ibx_member_id, display_name, relationship) VALUES (?, ?, ?)
       ON CONFLICT(ibx_member_id) DO UPDATE SET display_name = excluded.display_name,
         relationship = CASE WHEN excluded.relationship = 'unknown' THEN members.relationship ELSE excluded.relationship END`,
    )
    .run(m.ibx_member_id, m.display_name, m.relationship);
  return db().prepare('SELECT * FROM members WHERE ibx_member_id = ?').get(m.ibx_member_id) as unknown as Member;
}

export function updateMember(id: number, patch: { summit_claimant_label?: string | null; relationship?: string; display_name?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  db().prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
}

// ---------- claims ----------

const MAPPED_FIELDS: (keyof NormalizedClaim)[] = [
  'claim_number', 'member_ibx_id', 'service_start', 'service_end', 'provider_name', 'provider_phone', 'claim_type',
  'network_status', 'claim_status', 'processed_date', 'billed_cents', 'allowed_cents', 'deductible_cents',
  'copay_cents', 'coinsurance_cents', 'plan_paid_cents', 'patient_resp_cents',
];

export function claimHash(c: NormalizedClaim): string {
  const picked: Record<string, unknown> = {};
  for (const f of MAPPED_FIELDS) picked[f] = c[f];
  return sha256(canonicalJson(picked));
}

export function listClaims(): Claim[] {
  return db().prepare('SELECT * FROM claims ORDER BY service_start, claim_number').all() as unknown as Claim[];
}

export function getClaim(claimNumber: string): Claim | undefined {
  return db().prepare('SELECT * FROM claims WHERE claim_number = ?').get(claimNumber) as unknown as Claim | undefined;
}

export type UpsertOutcome = 'new' | 'unchanged' | 'changed';

/** Insert or update a claim from a portal record. Returns what happened so the fetch job can decide about the PDF. */
export function upsertClaim(c: NormalizedClaim, memberId: number): { outcome: UpsertOutcome; hash: string } {
  const hash = claimHash(c);
  const now = nowIso();
  const existing = getClaim(c.claim_number);
  const sourceJson = JSON.stringify(c.raw ?? {});
  if (!existing) {
    db()
      .prepare(
        `INSERT INTO claims(claim_number, member_id, service_start, service_end, provider_name, provider_phone, claim_type,
           network_status, claim_status, processed_date, billed_cents, allowed_cents, deductible_cents, copay_cents,
           coinsurance_cents, plan_paid_cents, patient_resp_cents, source_json, source_hash, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.claim_number, memberId, c.service_start, c.service_end, c.provider_name, c.provider_phone, c.claim_type,
        c.network_status, c.claim_status, c.processed_date, c.billed_cents, c.allowed_cents, c.deductible_cents,
        c.copay_cents, c.coinsurance_cents, c.plan_paid_cents, c.patient_resp_cents, sourceJson, hash, now, now,
      );
    return { outcome: 'new', hash };
  }
  if (existing.source_hash === hash) {
    db().prepare('UPDATE claims SET last_seen_at = ? WHERE claim_number = ?').run(now, c.claim_number);
    return { outcome: 'unchanged', hash };
  }
  db().prepare('INSERT INTO claims_history(claim_number, changed_at, old_json) VALUES (?,?,?)').run(
    c.claim_number, now, JSON.stringify(existing),
  );
  db()
    .prepare(
      `UPDATE claims SET member_id=?, service_start=?, service_end=?, provider_name=?, provider_phone=?, claim_type=?,
         network_status=?, claim_status=?, processed_date=?, billed_cents=?, allowed_cents=?, deductible_cents=?,
         copay_cents=?, coinsurance_cents=?, plan_paid_cents=?, patient_resp_cents=?, source_json=?, source_hash=?,
         last_seen_at=?, last_changed_at=? WHERE claim_number=?`,
    )
    .run(
      memberId, c.service_start, c.service_end, c.provider_name, c.provider_phone, c.claim_type, c.network_status,
      c.claim_status, c.processed_date, c.billed_cents, c.allowed_cents, c.deductible_cents, c.copay_cents,
      c.coinsurance_cents, c.plan_paid_cents, c.patient_resp_cents, sourceJson, hash, now, now, c.claim_number,
    );
  return { outcome: 'changed', hash };
}

export function setClaimOverride(claimNumber: string, qualifies: boolean | null, note: string | null): void {
  db().prepare('UPDATE claims SET user_override_qualifies = ?, user_note = ? WHERE claim_number = ?').run(
    qualifies === null ? null : qualifies ? 1 : 0, note, claimNumber,
  );
}

// ---------- eob files ----------

export function currentEobFile(claimNumber: string): EobFile | undefined {
  return db()
    .prepare('SELECT * FROM eob_files WHERE claim_number = ? AND superseded = 0 ORDER BY id DESC LIMIT 1')
    .get(claimNumber) as unknown as EobFile | undefined;
}

export function recordEobFile(f: Omit<EobFile, 'id' | 'superseded' | 'downloaded_at'>): void {
  db().prepare('UPDATE eob_files SET superseded = 1 WHERE claim_number = ?').run(f.claim_number);
  db()
    .prepare('INSERT INTO eob_files(claim_number, file_path, sha256, source_hash_at_download, downloaded_at) VALUES (?,?,?,?,?)')
    .run(f.claim_number, f.file_path, f.sha256, f.source_hash_at_download, nowIso());
}

export function eobFileMap(): Map<string, EobFile> {
  const rows = db().prepare('SELECT * FROM eob_files WHERE superseded = 0').all() as unknown as EobFile[];
  return new Map(rows.map((r) => [r.claim_number, r]));
}

// ---------- submissions ----------

export function listSubmissions(): Submission[] {
  return db().prepare('SELECT * FROM submissions ORDER BY id').all() as unknown as Submission[];
}

export function submissionsForClaim(claimNumber: string): Submission[] {
  return db().prepare('SELECT * FROM submissions WHERE claim_number = ? ORDER BY id').all(claimNumber) as unknown as Submission[];
}

export function getSubmission(id: number): Submission | undefined {
  return db().prepare('SELECT * FROM submissions WHERE id = ?').get(id) as unknown as Submission | undefined;
}

export function createSubmission(s: {
  claim_number: string;
  benefit: Benefit;
  submitted_via: 'app' | 'manual';
  amount_cents: number;
  claimant_label?: string | null;
  description?: string | null;
  notes?: string | null;
  status: SubmissionStatus;
  summit_claim_id?: string | null;
  submitted_at?: string | null;
  job_run_id?: number | null;
  approved_cents?: number | null;
  payment_method?: string | null;
}): Submission {
  const r = db()
    .prepare(
      `INSERT INTO submissions(claim_number, benefit, summit_claim_id, submitted_at, submitted_via, amount_cents, approved_cents, payment_method,
         claimant_label, description, notes, status, job_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      s.claim_number, s.benefit, s.summit_claim_id ?? null, s.submitted_at ?? null, s.submitted_via, s.amount_cents,
      s.approved_cents ?? null, s.payment_method ?? null,
      s.claimant_label ?? null, s.description ?? null, s.notes ?? null, s.status, s.job_run_id ?? null, nowIso(),
    );
  return getSubmission(Number(r.lastInsertRowid))!;
}

export function updateSubmission(id: number, patch: Partial<Pick<Submission, 'status' | 'summit_claim_id' | 'submitted_at' | 'status_checked_at' | 'approved_cents' | 'payment_method' | 'amount_cents'>>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  db().prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
}

// ---------- summit activity ----------

export function listSummitActivity(): SummitActivity[] {
  return db().prepare('SELECT * FROM summit_activity ORDER BY service_date DESC, id DESC').all() as unknown as SummitActivity[];
}

export function upsertSummitActivity(a: {
  summit_claim_id: string | null;
  claimant_label: string | null;
  service_date: string | null;
  amount_cents: number | null;
  status: string | null;
  posted_date: string | null;
  raw: unknown;
}): SummitActivity {
  const rawJson = JSON.stringify(a.raw ?? {});
  // Rows without a Summit id are identified by their content; rows with one by the id.
  const rawHash = a.summit_claim_id ? sha256(`id:${a.summit_claim_id}`) : sha256(canonicalJson(a.raw));
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO summit_activity(summit_claim_id, claimant_label, service_date, amount_cents, status, posted_date, raw_json,
         raw_hash, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(raw_hash) DO UPDATE SET claimant_label=excluded.claimant_label, service_date=excluded.service_date,
         amount_cents=excluded.amount_cents, status=excluded.status, posted_date=excluded.posted_date,
         raw_json=excluded.raw_json, last_seen_at=excluded.last_seen_at`,
    )
    .run(a.summit_claim_id, a.claimant_label, a.service_date, a.amount_cents, a.status, a.posted_date, rawJson, rawHash, now, now);
  return db().prepare('SELECT * FROM summit_activity WHERE raw_hash = ?').get(rawHash) as unknown as SummitActivity;
}

export function linkSummitActivity(id: number, claimNumber: string | null, method: string | null): void {
  db().prepare('UPDATE summit_activity SET matched_claim_number = ?, match_method = ? WHERE id = ?').run(claimNumber, method, id);
}

// ---------- job runs ----------

export function createJobRun(kind: JobKind, payload: unknown): JobRun {
  const r = db()
    .prepare('INSERT INTO job_runs(kind, status, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(kind, 'queued', JSON.stringify(payload ?? null), nowIso());
  return getJobRun(Number(r.lastInsertRowid))!;
}

export function getJobRun(id: number): JobRun | undefined {
  return db().prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as unknown as JobRun | undefined;
}

export function listJobRuns(limit = 30): JobRun[] {
  return db().prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?').all(limit) as unknown as JobRun[];
}

export function updateJobRun(
  id: number,
  patch: Partial<Pick<JobRun, 'status' | 'started_at' | 'finished_at' | 'progress_json' | 'message' | 'error_message' | 'screenshot_path' | 'trace_path' | 'log'>>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  db().prepare(`UPDATE job_runs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
}

export function appendJobLog(id: number, line: string): void {
  db().prepare("UPDATE job_runs SET log = log || ? WHERE id = ?").run(line + '\n', id);
}

/** On startup, anything left 'running' from a previous process is dead. */
export function failStaleJobs(): void {
  db()
    .prepare("UPDATE job_runs SET status = 'failed', error_message = 'Server restarted while job was running', finished_at = ? WHERE status IN ('queued','running','waiting_for_user')")
    .run(nowIso());
}

export function jobStatusOf(j: JobRun): JobStatus {
  return j.status;
}

export function rowToObject(r: Row): Row {
  return r;
}
