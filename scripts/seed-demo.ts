/**
 * Insert made-up claims so the dashboard can be exercised before the IBX fetch is configured.
 *   npx tsx scripts/seed-demo.ts        (adds demo rows; safe to re-run)
 *   npx tsx scripts/seed-demo.ts clear  (removes them)
 */
import { db } from '../src/db/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { currentEobFile, recordEobFile, setSettings, upsertClaim, upsertMember } from '../src/db/repo.js';
import { sha256 } from '../src/util/hash.js';
import { paths, safeName } from '../src/util/paths.js';
import type { NormalizedClaim } from '../src/types.js';

const DEMO_PREFIX = 'DEMO-';

if (process.argv[2] === 'clear') {
  const d = db();
  d.prepare(`DELETE FROM eob_files WHERE claim_number LIKE '${DEMO_PREFIX}%'`).run();
  d.prepare(`DELETE FROM submissions WHERE claim_number LIKE '${DEMO_PREFIX}%'`).run();
  d.prepare(`DELETE FROM claims_history WHERE claim_number LIKE '${DEMO_PREFIX}%'`).run();
  d.prepare(`DELETE FROM claims WHERE claim_number LIKE '${DEMO_PREFIX}%'`).run();
  d.prepare(`DELETE FROM members WHERE ibx_member_id LIKE '${DEMO_PREFIX}%'`).run();
  for (const dir of ['Demo Employee', 'Demo Spouse', 'Demo Child']) fs.rmSync(path.join(paths.eobs, dir), { recursive: true, force: true });
  setSettings({ last_ibx_fetch_at: null, last_summit_sync_at: null });
  console.log('Demo claims, members and PDFs removed');
  process.exit(0);
}

const members = [
  upsertMember({ ibx_member_id: 'DEMO-01', display_name: 'Demo Employee', relationship: 'self' }),
  upsertMember({ ibx_member_id: 'DEMO-02', display_name: 'Demo Spouse', relationship: 'spouse' }),
  upsertMember({ ibx_member_id: 'DEMO-03', display_name: 'Demo Child', relationship: 'child' }),
];

const base = (o: Partial<NormalizedClaim> & { n: number; m: number }): NormalizedClaim => ({
  claim_number: `${DEMO_PREFIX}${String(o.n).padStart(4, '0')}`,
  member_ibx_id: members[o.m].ibx_member_id,
  member_name: members[o.m].display_name,
  relationship: members[o.m].relationship,
  service_start: '2026-01-10',
  service_end: '2026-01-10',
  provider_name: 'Demo Provider',
  provider_phone: null,
  claim_type: 'medical',
  network_status: 'in',
  claim_status: 'processed',
  processed_date: '2026-02-01',
  billed_cents: 0, allowed_cents: 0, deductible_cents: 0, copay_cents: 0, coinsurance_cents: 0, plan_paid_cents: 0, patient_resp_cents: 0,
  raw: { demo: true },
  eob_ref: null,
  ...o,
});

const rows: NormalizedClaim[] = [
  base({ n: 1, m: 0, service_start: '2026-01-12', service_end: '2026-01-12', provider_name: 'Lafayette Hill Family Practice', billed_cents: 24_000, allowed_cents: 15_200, copay_cents: 4_000, plan_paid_cents: 11_200, patient_resp_cents: 4_000 }),
  base({ n: 2, m: 1, service_start: '2026-02-03', service_end: '2026-02-03', provider_name: 'Main Line Imaging', billed_cents: 310_000, allowed_cents: 182_000, deductible_cents: 182_000, patient_resp_cents: 182_000 }),
  base({ n: 3, m: 2, service_start: '2026-02-20', service_end: '2026-02-20', provider_name: 'CHOP Urgent Care', billed_cents: 45_000, allowed_cents: 30_000, copay_cents: 8_000, plan_paid_cents: 22_000, patient_resp_cents: 8_000 }),
  base({ n: 4, m: 0, service_start: '2026-03-15', service_end: '2026-03-17', provider_name: 'Einstein Medical Center', billed_cents: 1_900_000, allowed_cents: 720_000, deductible_cents: 293_000, coinsurance_cents: 0, plan_paid_cents: 427_000, patient_resp_cents: 293_000 }),
  base({ n: 5, m: 1, service_start: '2026-04-02', service_end: '2026-04-02', provider_name: 'Suburban Surgical Center', billed_cents: 880_000, allowed_cents: 410_000, deductible_cents: 300_000, plan_paid_cents: 110_000, patient_resp_cents: 300_000 }),
  base({ n: 6, m: 2, service_start: '2026-05-11', service_end: '2026-05-11', provider_name: 'Out of Network Pediatrics', network_status: 'out', billed_cents: 50_000, allowed_cents: 20_000, deductible_cents: 20_000, patient_resp_cents: 50_000 }),
  base({ n: 7, m: 0, service_start: '2026-06-30', service_end: '2026-06-30', provider_name: 'Quest Diagnostics', billed_cents: 12_000, allowed_cents: 4_000, plan_paid_cents: 4_000 }),
  base({ n: 8, m: 1, service_start: '2026-07-08', service_end: '2026-07-08', provider_name: 'Abington Hospital ER', claim_status: 'pending', billed_cents: 420_000, allowed_cents: 0 }),
  base({ n: 9, m: 0, service_start: '2026-08-19', service_end: '2026-08-19', provider_name: 'Penn Orthopaedics', billed_cents: 150_000, allowed_cents: 92_000, deductible_cents: 92_000, patient_resp_cents: 92_000 }),
  base({ n: 10, m: 2, service_start: '2026-09-02', service_end: '2026-09-02', provider_name: 'CVS Pharmacy', claim_type: 'rx', billed_cents: 6_000, allowed_cents: 4_000, copay_cents: 1_500, plan_paid_cents: 2_500, patient_resp_cents: 1_500 }),
];

const MINIMAL_PDF = (title: string) =>
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${44 + title.length}>>stream
BT /F1 18 Tf 72 720 Td (DEMO EOB ${title}) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`.padEnd(600, ' ');

for (const r of rows) {
  const m = members.find((x) => x.ibx_member_id === r.member_ibx_id)!;
  const { outcome, hash } = upsertClaim(r, m.id);
  if (!currentEobFile(r.claim_number)) {
    const dir = path.join(paths.eobs, safeName(r.member_name));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${r.claim_number}_demo.pdf`);
    const buf = Buffer.from(MINIMAL_PDF(r.claim_number), 'latin1');
    fs.writeFileSync(file, buf);
    recordEobFile({ claim_number: r.claim_number, file_path: file, sha256: sha256(buf), source_hash_at_download: hash });
  }
  console.log(r.claim_number, outcome);
}
setSettings({ last_ibx_fetch_at: new Date().toISOString(), last_summit_sync_at: new Date().toISOString() });
console.log('Demo claims seeded. Run with "clear" to remove.');
