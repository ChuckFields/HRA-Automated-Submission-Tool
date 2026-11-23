// Generated from the SQL below; kept as a TS string so it bundles into the single exe.
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ibx_member_id         TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  relationship          TEXT NOT NULL DEFAULT 'unknown',
  summit_claimant_label TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  claim_number            TEXT PRIMARY KEY,
  member_id               INTEGER REFERENCES members(id),
  service_start           TEXT NOT NULL,
  service_end             TEXT NOT NULL,
  provider_name           TEXT,
  provider_phone          TEXT,
  claim_type              TEXT NOT NULL DEFAULT 'medical',
  network_status          TEXT NOT NULL DEFAULT 'unknown',
  claim_status            TEXT NOT NULL DEFAULT 'unknown',
  processed_date          TEXT,
  billed_cents            INTEGER NOT NULL DEFAULT 0,
  allowed_cents           INTEGER NOT NULL DEFAULT 0,
  deductible_cents        INTEGER NOT NULL DEFAULT 0,
  copay_cents             INTEGER NOT NULL DEFAULT 0,
  coinsurance_cents       INTEGER NOT NULL DEFAULT 0,
  plan_paid_cents         INTEGER NOT NULL DEFAULT 0,
  patient_resp_cents      INTEGER NOT NULL DEFAULT 0,
  source_json             TEXT NOT NULL DEFAULT '{}',
  source_hash             TEXT NOT NULL DEFAULT '',
  first_seen_at           TEXT NOT NULL,
  last_seen_at            TEXT NOT NULL,
  last_changed_at         TEXT,
  user_override_qualifies INTEGER,
  user_note               TEXT
);

CREATE TABLE IF NOT EXISTS claims_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_number TEXT NOT NULL REFERENCES claims(claim_number),
  changed_at   TEXT NOT NULL,
  old_json     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eob_files (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_number            TEXT NOT NULL REFERENCES claims(claim_number),
  file_path               TEXT NOT NULL,
  sha256                  TEXT NOT NULL,
  source_hash_at_download TEXT NOT NULL,
  downloaded_at           TEXT NOT NULL,
  superseded              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eob_files_claim ON eob_files(claim_number, superseded);

CREATE TABLE IF NOT EXISTS submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_number      TEXT NOT NULL REFERENCES claims(claim_number),
  benefit           TEXT NOT NULL DEFAULT 'deductible',
  summit_claim_id   TEXT,
  submitted_at      TEXT,
  submitted_via     TEXT NOT NULL DEFAULT 'app',
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  approved_cents    INTEGER,
  payment_method    TEXT,
  claimant_label    TEXT,
  description       TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'unconfirmed',
  status_checked_at TEXT,
  job_run_id        INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_claim ON submissions(claim_number);

CREATE TABLE IF NOT EXISTS summit_activity (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  summit_claim_id      TEXT UNIQUE,
  claimant_label       TEXT,
  service_date         TEXT,
  amount_cents         INTEGER,
  status               TEXT,
  posted_date          TEXT,
  raw_json             TEXT NOT NULL,
  raw_hash             TEXT NOT NULL,
  matched_claim_number TEXT REFERENCES claims(claim_number),
  match_method         TEXT,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_summit_activity_hash ON summit_activity(raw_hash);

CREATE TABLE IF NOT EXISTS job_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  payload_json    TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  progress_json   TEXT,
  message         TEXT,
  error_message   TEXT,
  screenshot_path TEXT,
  trace_path      TEXT,
  log             TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
`;
