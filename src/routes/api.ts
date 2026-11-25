import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getClaim,
  getJobRun,
  getSettings,
  getSubmission,
  isSetupComplete,
  listClaims,
  listSubmissions,
  linkSummitActivity,
  listJobRuns,
  listMembers,
  listSummitActivity,
  createSubmission,
  currentEobFile,
  setClaimOverride,
  setSettings,
  updateMember,
  updateSubmission,
} from '../db/repo.js';
import { credentialStatus, saveCredentials } from '../security/credentials.js';
import { runner, type JobEvent } from '../jobs/runner.js';
import { planPrefill } from '../jobs/prefill.js';
import { matchActivity, syncSubmissionFromActivity } from '../jobs/syncSummit.js';
import { buildClaimsView } from '../services/claimsView.js';
import { resetAllData } from '../services/reset.js';
import { runBridge, type BridgeCommand } from '../dev/pageBridge.js';
import { DEDUCTIBLE_RULES, PLAN_LABELS } from '../eligibility/rules.js';
import { nowIso } from '../util/dates.js';
import { DATA_DIR, IS_SEA, paths } from '../util/paths.js';
import { ibxConfig } from '../portals/ibx/config.js';
import type { Benefit } from '../types.js';

const settingsSchema = z.object({
  plan_option: z.enum(['gold', 'silver']).nullable().optional(),
  coverage_tier: z.enum(['single', 'family']).nullable().optional(),
  plan_year: z.number().int().min(2024).max(2100).optional(),
  plan_source: z.enum(['summit', 'ibx', 'manual']).nullable().optional(),
  summit_base_url: z.string().url().optional(),
  ibx_member_url: z.string().url().optional(),
  last_ibx_fetch_claims: z.number().int().nullable().optional(),
  last_ibx_fetch_pdfs: z.number().int().nullable().optional(),
  last_summit_sync_transactions: z.number().int().nullable().optional(),
});

const credsSchema = z.object({
  username: z.string().min(1),
  password: z.string().optional().default(''),
  securityAnswers: z.record(z.string(), z.string()).optional(),
});

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get('/api/state', async () => {
    const settings = getSettings();
    return {
      setup_complete: isSetupComplete(settings),
      settings,
      credentials: credentialStatus(),
      members: listMembers(),
      plans: Object.entries(PLAN_LABELS).map(([key, label]) => ({ key, label, rules: DEDUCTIBLE_RULES[key as 'gold' | 'silver'] })),
      portals: { ibx_configured: ibxConfig.claims.configured },
      data_dir: DATA_DIR,
      busy: runner.isBusy(),
      current_job_id: runner.currentJobId(),
    };
  });

  app.get('/api/claims', async () => buildClaimsView());

  app.put('/api/settings', async (req) => setSettings(settingsSchema.parse(req.body)));

  app.put<{ Params: { portal: string } }>('/api/credentials/:portal', async (req, reply) => {
    const portal = req.params.portal;
    if (portal !== 'ibx' && portal !== 'summit') return reply.code(400).send({ error: 'portal must be ibx or summit' });
    saveCredentials(portal, credsSchema.parse(req.body));
    return credentialStatus();
  });

  app.put<{ Params: { id: string } }>('/api/members/:id', async (req) => {
    const body = z.object({
      summit_claimant_label: z.string().nullable().optional(),
      relationship: z.string().optional(),
      display_name: z.string().min(1).optional(),
    }).parse(req.body);
    updateMember(Number(req.params.id), body);
    return listMembers();
  });

  // ----- jobs -----
  app.post('/api/jobs/fetch', async () => runner.enqueue('fetch_eobs'));
  /** Read EOB PDFs from a folder on this computer instead of fetching them from IBX. */
  app.post('/api/jobs/import-eobs', async (req, reply) => {
    const body = z.object({ folder: z.string().trim().min(1), dry_run: z.boolean().optional() }).parse(req.body ?? {});
    const folder = path.resolve(body.folder.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return reply.code(400).send({ error: `Not a folder on this computer: ${folder}` });
    return runner.enqueue('import_eobs', { folder, dry_run: Boolean(body.dry_run) });
  });
  app.post('/api/jobs/sync-summit', async () => runner.enqueue('sync_summit'));
  app.post('/api/jobs/noop', async () => runner.enqueue('noop'));

  app.get('/api/jobs', async () => listJobRuns());
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req, reply) => {
    const ok = await runner.cancel(Number(req.params.id));
    return ok ? { ok: true } : reply.code(409).send({ error: 'That job is not running' });
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => getJobRun(Number(req.params.id)) ?? reply.code(404).send({ error: 'not found' }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id/screenshot', async (req, reply) => {
    const job = getJobRun(Number(req.params.id));
    if (!job?.screenshot_path || !fs.existsSync(job.screenshot_path)) return reply.code(404).send({ error: 'no screenshot' });
    return reply.type('image/png').send(fs.createReadStream(job.screenshot_path));
  });

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(`data: ${JSON.stringify({ type: 'hello', jobs: listJobRuns(10) })}\n\n`);
    const onEvent = (e: JobEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    runner.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      runner.off('event', onEvent);
      clearInterval(ping);
    });
  });

  // ----- claims -----
  const benefitSchema = z.enum(['deductible', 'copay']);

  app.get<{ Params: { n: string }; Querystring: { benefit?: string } }>('/api/claims/:n/prefill-plan', async (req, reply) => {
    try {
      return planPrefill(req.params.n, benefitSchema.parse(req.query.benefit));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { n: string } }>('/api/claims/:n/prefill', async (req, reply) => {
    const { benefit, force, finish_later } = z.object({ benefit: benefitSchema, force: z.boolean().optional(), finish_later: z.boolean().optional() }).parse(req.body ?? {});
    if (!getClaim(req.params.n)) return reply.code(404).send({ error: 'unknown claim' });
    try {
      planPrefill(req.params.n, benefit); // fail fast before opening a browser
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return runner.enqueue('prefill', { claim_number: req.params.n, benefit, force: Boolean(force), finish_later: Boolean(finish_later) });
  });

  /**
   * Queue a save-as-draft prefill for every claim and benefit that has an amount on the EOB and no live
   * submission yet, whatever the eligibility estimate says. Nothing is submitted; each lands in Summit's
   * "Unfinished Claims". Pass { dry_run: true } to only list what would be queued.
   */
  app.post('/api/jobs/draft-all', async (req) => {
    const { dry_run } = z.object({ dry_run: z.boolean().optional() }).parse(req.body ?? {});
    const todo: { claim_number: string; benefit: Benefit; amount_cents: number }[] = [];
    for (const r of buildClaimsView().rows) {
      if (!r.has_pdf || r.user_override_qualifies === 0) continue;
      for (const benefit of ['copay', 'deductible'] as Benefit[]) {
        const amount = benefit === 'copay' ? r.copay_cents : r.deductible_cents;
        if (amount > 0 && !r.submissions[benefit]) todo.push({ claim_number: r.claim_number, benefit, amount_cents: amount });
      }
    }
    const jobs = dry_run ? [] : todo.map((t) => runner.enqueue('prefill', { claim_number: t.claim_number, benefit: t.benefit, force: false, finish_later: true }).id);
    return { queued: jobs.length, jobs, claims: todo };
  });

  app.put<{ Params: { n: string } }>('/api/claims/:n/override', async (req) => {
    const body = z.object({ qualifies: z.boolean().nullable(), note: z.string().nullable().optional() }).parse(req.body);
    setClaimOverride(req.params.n, body.qualifies, body.note ?? null);
    return { ok: true };
  });

  app.post<{ Params: { n: string } }>('/api/claims/:n/mark-submitted', async (req, reply) => {
    const claim = getClaim(req.params.n);
    if (!claim) return reply.code(404).send({ error: 'unknown claim' });
    const body = z.object({
      benefit: benefitSchema,
      amount_cents: z.number().int().optional(),
      summit_claim_id: z.string().optional(),
      submitted_at: z.string().optional(),
      status: z.enum(['submitted', 'pending', 'approved', 'paid', 'denied']).optional(),
    }).parse(req.body ?? {});
    return createSubmission({
      claim_number: claim.claim_number,
      benefit: body.benefit,
      submitted_via: 'manual',
      amount_cents: body.amount_cents ?? (body.benefit === 'deductible' ? claim.deductible_cents : claim.copay_cents),
      summit_claim_id: body.summit_claim_id ?? null,
      submitted_at: body.submitted_at ?? nowIso(),
      status: body.status ?? 'submitted',
    });
  });

  app.get<{ Params: { n: string } }>('/api/eobs/:n/pdf', async (req, reply) => {
    const f = currentEobFile(req.params.n);
    if (!f || !fs.existsSync(f.file_path)) return reply.code(404).send({ error: 'no PDF for this claim' });
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${path.basename(f.file_path)}"`)
      .send(fs.createReadStream(f.file_path));
  });

  /**
   * Submit what is in Summit's "Unfinished Claims" list (see jobs/submitDrafts.ts). This is the one place the app
   * clicks Submit Claim, and only on drafts the user has had the chance to review in Summit.
   */
  app.post('/api/jobs/submit-drafts', async (req) => {
    const body = z.object({ dry_run: z.boolean().optional(), limit: z.number().int().positive().optional() }).parse(req.body ?? {});
    return runner.enqueue('submit_drafts', body);
  });

  // ----- submissions -----
  app.post<{ Params: { id: string } }>('/api/submissions/:id/confirm', async (req, reply) => {
    const sub = getSubmission(Number(req.params.id));
    if (!sub) return reply.code(404).send({ error: 'unknown submission' });
    const { outcome, summit_claim_id } = z.object({ outcome: z.enum(['submitted', 'cancelled']), summit_claim_id: z.string().optional() }).parse(req.body);
    updateSubmission(sub.id, {
      status: outcome,
      submitted_at: outcome === 'submitted' ? sub.submitted_at ?? nowIso() : sub.submitted_at,
      summit_claim_id: summit_claim_id ?? sub.summit_claim_id,
    });
    return getSubmission(sub.id);
  });

  // ----- summit activity -----
  app.get('/api/summit-activity', async () => listSummitActivity());
  app.post<{ Params: { id: string } }>('/api/summit-activity/:id/link', async (req, reply) => {
    const { claim_number } = z.object({ claim_number: z.string().nullable() }).parse(req.body);
    const row = listSummitActivity().find((a) => a.id === Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'unknown activity row' });
    linkSummitActivity(row.id, claim_number, claim_number ? 'manual' : null);
    if (claim_number) syncSubmissionFromActivity({ ...row, matched_claim_number: claim_number }, () => undefined);
    return { ok: true };
  });
  app.post('/api/summit-activity/rematch', async () => matchActivity(() => undefined));

  app.get('/api/paths', async () => paths);

  /** Everything useful for troubleshooting, with nothing secret: no passwords, usernames or people's names. */
  app.get('/api/logs/export', async (_req, reply) => {
    const s = getSettings();
    const creds = credentialStatus();
    const lines: string[] = [];
    lines.push('HRA Automated Submission Tool — support export');
    lines.push(`Exported: ${nowIso()}`);
    lines.push(`Platform: ${process.platform} ${os.release()} | Node ${process.version} | packaged: ${IS_SEA}`);
    lines.push(`Data folder: ${DATA_DIR}`);
    lines.push('');
    lines.push('Settings (secrets removed):');
    lines.push(`  plan_option=${s.plan_option} coverage_tier=${s.coverage_tier} plan_year=${s.plan_year} plan_source=${s.plan_source}`);
    lines.push(`  summit_base_url=${s.summit_base_url} claimants_known=${s.summit_claimants.length}`);
    lines.push(`  ibx_login_saved=${creds.ibx} summit_login_saved=${creds.summit}`);
    lines.push(`  last_ibx_fetch_at=${s.last_ibx_fetch_at} last_summit_sync_at=${s.last_summit_sync_at}`);
    lines.push(`  members=${listMembers().length} claims=${listClaims().length} submissions=${listSubmissions().length}`);
    lines.push('');
    for (const j of listJobRuns(50).reverse()) {
      lines.push(`==== Job #${j.id} ${j.kind} — ${j.status} ====`);
      lines.push(`started=${j.started_at} finished=${j.finished_at}`);
      if (j.progress_json) lines.push(`progress=${j.progress_json}`);
      if (j.message) lines.push(`message=${j.message}`);
      if (j.error_message) lines.push(`error=${j.error_message}`);
      if (j.screenshot_path) lines.push(`screenshot=${j.screenshot_path}`);
      lines.push(j.log.trimEnd());
      lines.push('');
    }
    const name = `hra-tool-logs-${nowIso().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`).send(lines.join('\r\n'));
  });

  /** Developer bridge (dev builds only): drive the browser window a running job has open. */
  if (!IS_SEA) {
    app.post<{ Params: { portal: string } }>('/api/dev/explore/:portal', async (req) => runner.enqueue('explore', { portal: req.params.portal }));
    app.post<{ Params: { name: string } }>('/api/dev/bridge/:name', async (req, reply) => {
      try {
        return { result: await runBridge(req.params.name, req.body as BridgeCommand) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
  }

  /** Delete everything the app stored on this computer. The UI asks for confirmation first. */
  app.post('/api/reset', async (req, reply) => {
    const { confirm } = z.object({ confirm: z.literal('DELETE') }).parse(req.body ?? {});
    void confirm;
    if (runner.isBusy()) return reply.code(409).send({ error: 'A job is still running. Wait for it to finish (or close its browser window) and try again.' });
    const result = resetAllData();
    if (result.failed.length) return reply.code(500).send({ error: `Some files could not be removed: ${result.failed.join('; ')}`, ...result });
    return result;
  });
}
