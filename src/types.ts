export type PlanOption = 'gold' | 'silver';
export type CoverageTier = 'single' | 'family';
export type NetworkStatus = 'in' | 'out' | 'unknown';
export type ClaimStatus = 'processed' | 'pending' | 'adjusted' | 'denied' | 'unknown';
export type ClaimType = 'medical' | 'rx' | 'dental' | 'vision' | 'unknown';
export type JobKind = 'fetch_eobs' | 'sync_summit' | 'prefill' | 'explore' | 'noop';
export type JobStatus = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed';
/** The MERP has two separate benefits, each its own Summit account and its own claim. */
export type Benefit = 'deductible' | 'copay';
export type SubmissionStatus =
  | 'unconfirmed'
  | 'submitted'
  | 'pending'
  | 'approved'
  | 'paid'
  | 'denied'
  | 'cancelled'
  | 'unknown';

export interface Member {
  id: number;
  ibx_member_id: string;
  display_name: string;
  relationship: string;
  /** Summit's internal claimant id (the <option value>), chosen in Settings. */
  summit_claimant_label: string | null;
}

export interface Claim {
  claim_number: string;
  member_id: number | null;
  service_start: string;
  service_end: string;
  provider_name: string | null;
  provider_phone: string | null;
  claim_type: ClaimType;
  network_status: NetworkStatus;
  claim_status: ClaimStatus;
  processed_date: string | null;
  billed_cents: number;
  allowed_cents: number;
  deductible_cents: number;
  copay_cents: number;
  coinsurance_cents: number;
  plan_paid_cents: number;
  patient_resp_cents: number;
  source_json: string;
  source_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string | null;
  user_override_qualifies: number | null;
  user_note: string | null;
}

/** What a portal adapter returns for one claim, before it is stored. */
export interface NormalizedClaim {
  claim_number: string;
  member_ibx_id: string;
  member_name: string;
  relationship: string;
  service_start: string;
  service_end: string;
  provider_name: string | null;
  provider_phone: string | null;
  claim_type: ClaimType;
  network_status: NetworkStatus;
  claim_status: ClaimStatus;
  processed_date: string | null;
  billed_cents: number;
  allowed_cents: number;
  deductible_cents: number;
  copay_cents: number;
  coinsurance_cents: number;
  plan_paid_cents: number;
  patient_resp_cents: number;
  /** Raw portal record, stored verbatim for debugging. */
  raw: unknown;
  /** Whatever the adapter needs to fetch this claim's EOB PDF later. */
  eob_ref: unknown;
}

export interface EobFile {
  id: number;
  claim_number: string;
  file_path: string;
  sha256: string;
  source_hash_at_download: string;
  downloaded_at: string;
  superseded: number;
}

export interface Submission {
  id: number;
  claim_number: string;
  benefit: Benefit;
  summit_claim_id: string | null;
  submitted_at: string | null;
  submitted_via: 'app' | 'manual';
  amount_cents: number;
  /** What Summit shows as the approved amount (the claim amount, before Alera's 50% / band maths). */
  approved_cents: number | null;
  payment_method: string | null;
  claimant_label: string | null;
  description: string | null;
  notes: string | null;
  status: SubmissionStatus;
  status_checked_at: string | null;
  job_run_id: number | null;
  created_at: string;
}

export interface SummitActivity {
  id: number;
  summit_claim_id: string | null;
  claimant_label: string | null;
  service_date: string | null;
  amount_cents: number | null;
  status: string | null;
  posted_date: string | null;
  raw_json: string;
  matched_claim_number: string | null;
  match_method: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface JobRun {
  id: number;
  kind: JobKind;
  status: JobStatus;
  payload_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  progress_json: string | null;
  message: string | null;
  error_message: string | null;
  screenshot_path: string | null;
  trace_path: string | null;
  log: string;
  created_at: string;
}

export interface SummitClaimant {
  value: string;
  label: string;
}

export interface Settings {
  plan_option: PlanOption | null;
  coverage_tier: CoverageTier | null;
  plan_year: number;
  /** Where plan/tier came from: detected from a portal, or set by hand (which detection then leaves alone). */
  plan_source: 'summit' | 'ibx' | 'manual' | null;
  summit_base_url: string;
  /** Claimant dropdown options read from Summit during the last sync. */
  summit_claimants: SummitClaimant[];
  ibx_member_url: string;
  /** When each portal was last read successfully; the Claims tab needs both. */
  last_ibx_fetch_at: string | null;
  last_summit_sync_at: string | null;
  /** What the last successful runs found, for the Setup tab. */
  last_ibx_fetch_claims: number | null;
  last_ibx_fetch_pdfs: number | null;
  last_summit_sync_transactions: number | null;
}
