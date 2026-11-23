import fs from 'node:fs';
import path from 'node:path';
import { currentEobFile, getSettings, recordEobFile, setSettings, submissionsForClaim, upsertClaim, upsertMember } from '../db/repo.js';
import { launchPortal, step } from '../portals/shared/browser.js';
import { downloadEob, listClaims, loadProfile, planOptionFromName, titleCase } from '../portals/ibx/config.js';
import { ensureIbxLoggedIn } from '../portals/ibx/session.js';
import { requireCredentials } from '../security/credentials.js';
import { registerBridgePage } from '../dev/pageBridge.js';
import { sha256 } from '../util/hash.js';
import { paths, safeName } from '../util/paths.js';
import type { JobContext } from './runner.js';
import type { NormalizedClaim } from '../types.js';

function pdfPathFor(c: NormalizedClaim): string {
  // Folder per person; the relationship keeps a parent and child with the same name apart.
  const dir = path.join(paths.eobs, safeName(`${c.member_name || c.member_ibx_id} (${c.relationship})`));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (c.processed_date ?? c.service_start ?? 'unknown').replace(/-/g, '');
  let file = path.join(dir, `${safeName(c.claim_number)}_${stamp}.pdf`);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${safeName(c.claim_number)}_${stamp}_${i++}.pdf`);
  return file;
}

export async function fetchEobsJob(job: JobContext): Promise<string> {
  const settings = getSettings();
  const year = settings.plan_year;
  const username = requireCredentials('ibx').username;
  const session = await launchPortal('ibx', job);
  registerBridgePage('ibx', session.page);
  let ok = false;
  const counts = { found: 0, new: 0, changed: 0, unchanged: 0, downloaded: 0, failed: 0 };
  try {
    await ensureIbxLoggedIn(session.page, job);
    const ctx = { context: session.context, page: session.page, year, username, log: job.log };

    const profile = await step(job, session.page, 'Read who is covered', () => loadProfile(ctx));
    for (const p of profile.persons) {
      upsertMember({ ibx_member_id: p.memberId, display_name: titleCase(`${p.firstName} ${p.lastName}`), relationship: p.relationship });
    }
    job.log(`Covered: ${profile.persons.map((p) => `${titleCase(p.firstName)} (${p.relationship})`).join(', ')}`);

    // Plan and tier straight from IBX, unless the user set them by hand.
    const current = getSettings();
    if (current.plan_source !== 'manual') {
      const patch: Record<string, unknown> = {};
      const tier = profile.persons.length > 1 ? 'family' : 'single';
      if (current.coverage_tier !== tier) patch.coverage_tier = tier;
      const plan = planOptionFromName(profile.planName);
      if (plan && (current.plan_option !== plan || !current.plan_source)) {
        patch.plan_option = plan;
        patch.plan_source = 'ibx';
      }
      if (Object.keys(patch).length) {
        setSettings(patch);
        job.log(`Detected from IBX: ${profile.planName ?? 'plan name unknown'}, ${tier} coverage`);
      }
    }

    const claims = await step(job, session.page, `List ${year} claims`, () => listClaims(ctx, profile));
    counts.found = claims.length;
    job.log(`IBX returned ${claims.length} claims for ${year}`);
    job.progress(counts);

    for (const c of claims) {
      const member = upsertMember({ ibx_member_id: c.member_ibx_id, display_name: c.member_name, relationship: c.relationship });
      const { outcome, hash } = upsertClaim(c, member.id);
      counts[outcome] += 1;

      const existing = currentEobFile(c.claim_number);
      const haveFile = existing && fs.existsSync(existing.file_path);
      const needDownload = outcome !== 'unchanged' || !haveFile;
      if (outcome === 'changed') {
        const real = submissionsForClaim(c.claim_number).some((s) => s.status !== 'cancelled' && s.status !== 'unconfirmed');
        job.log(`Claim ${c.claim_number} changed on IBX${real ? ' AFTER it was submitted to Summit; review it' : ''}`);
      }
      if (!needDownload || !c.eob_ref) {
        job.progress(counts); // nothing new, or a claim type with no document
        continue;
      }

      try {
        const buf = await step(job, session.page, `Download EOB ${c.claim_number}`, () => downloadEob(ctx, c, profile));
        if (buf.length < 500 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new Error(`Downloaded file for ${c.claim_number} is not a PDF (${buf.length} bytes)`);
        }
        const digest = sha256(buf);
        if (existing && existing.sha256 === digest && haveFile) {
          recordEobFile({ claim_number: c.claim_number, file_path: existing.file_path, sha256: digest, source_hash_at_download: hash });
          job.log(`EOB ${c.claim_number}: identical PDF already on disk`);
        } else {
          const file = pdfPathFor(c);
          fs.writeFileSync(file, buf);
          recordEobFile({ claim_number: c.claim_number, file_path: file, sha256: digest, source_hash_at_download: hash });
          counts.downloaded += 1;
          job.log(`Saved ${path.relative(paths.data, file)}`);
        }
      } catch (err) {
        counts.failed += 1;
        job.log(`WARNING ${(err as Error).message}`);
      }
      job.progress(counts);
    }
    ok = counts.failed === 0;
    if (ok) {
      const pdfs = claims.filter((c) => c.eob_ref && currentEobFile(c.claim_number)).length;
      setSettings({ last_ibx_fetch_at: new Date().toISOString(), last_ibx_fetch_claims: counts.found, last_ibx_fetch_pdfs: pdfs });
    }
    const summary = `${counts.found} claims: ${counts.new} new, ${counts.changed} changed, ${counts.unchanged} unchanged, ${counts.downloaded} PDFs downloaded${counts.failed ? `, ${counts.failed} downloads failed` : ''}`;
    if (!ok) throw new Error(summary);
    return summary;
  } finally {
    await session.finish(ok);
  }
}
