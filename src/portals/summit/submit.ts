import type { Locator, Page } from 'playwright-core';
import type { JobContext } from '../../jobs/runner.js';
import { screenshot, sleep, step } from '../shared/browser.js';
import { summitConfig as cfg } from './config.js';
import { summitUrl } from './session.js';
import type { Benefit, SummitClaimant } from '../../types.js';

export interface PrefillPayload {
  benefit: Benefit;
  /** Summit <option value> for the claimant; empty when the user has to pick. */
  claimant_value: string;
  claimant_label: string;
  service_start_us: string;
  service_end_us: string;
  amount_plain: string;
  provider: string;
  category_value: string;
  category_label: string;
  code_value: string;
  code_label: string;
  description: string;
  notes: string;
  pdf_path: string;
}

/** The first <tag> that follows the <label> whose text starts with `label`. */
export function fieldAfterLabel(page: Page, label: string, tag: string): Locator {
  return page.locator(`xpath=//label[starts-with(normalize-space(.), "${label}")]/following::${tag}[1]`).first();
}

async function typeInto(loc: Locator, value: string): Promise<void> {
  await loc.click();
  await loc.fill('');
  await loc.pressSequentially(value, { delay: 20 });
  await loc.press('Tab').catch(() => undefined);
}

/** Read the Claimant dropdown so Settings can offer the real options (Summit ids, not names). */
export async function readClaimantOptions(page: Page): Promise<SummitClaimant[]> {
  const sel = fieldAfterLabel(page, cfg.form.labels.claimant.label, 'select');
  const opts = await sel.locator('option').evaluateAll((els) =>
    els.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? '').trim() })),
  );
  return opts.filter((o) => o.value && !/^select/i.test(o.label));
}

/** Navigate to the claim form and fill every field. Never clicks Submit. */
export async function prefillClaimForm(page: Page, job: JobContext, p: PrefillPayload): Promise<void> {
  const L = cfg.form.labels;
  const f = (k: keyof typeof L) => fieldAfterLabel(page, L[k].label, L[k].tag);

  await step(job, page, 'Open the "Enter a Claim" form', async () => {
    await page.goto(summitUrl(cfg.paths.claimForm), { waitUntil: 'domcontentloaded' });
    await page.locator(cfg.form.submitButton).first().waitFor({ state: 'visible', timeout: 30_000 });
    await sleep(1000);
  });

  await step(job, page, 'Attach the EOB PDF', async () => {
    await page.locator(cfg.form.fileInput).first().setInputFiles(p.pdf_path);
    await sleep(2000);
  });

  await step(job, page, 'Choose claimant', async () => {
    if (!p.claimant_value) {
      job.log('No Summit claimant id saved for this member; leaving the Claimant dropdown for you to pick.');
      return;
    }
    await f('claimant').selectOption({ value: p.claimant_value });
  });

  await step(job, page, 'Fill service dates', async () => {
    await typeInto(f('serviceStart'), p.service_start_us);
    await typeInto(f('serviceEnd'), p.service_end_us);
  });

  await step(job, page, 'Fill amount and provider', async () => {
    await typeInto(f('amount'), p.amount_plain);
    await typeInto(f('provider'), p.provider);
  });

  await step(job, page, `Choose service category "${p.category_label}"`, async () => {
    await f('category').selectOption({ value: p.category_value });
    await sleep(1200);
  });

  await step(job, page, `Choose service code "${p.code_label}"`, async () => {
    const code = f('code');
    const values = await code.locator('option').evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value));
    if (values.includes(p.code_value)) await code.selectOption({ value: p.code_value });
    else job.log(`Service code ${p.code_value} not offered for this category; leaving it for you to pick.`);
  });

  await step(job, page, 'Fill description', async () => typeInto(f('description'), p.description));

  await step(job, page, 'Check requested account', async () => {
    const acct = f('account');
    for (let i = 0; i < 10; i++) {
      const selected = (await acct.inputValue().catch(() => '')) || '';
      if (selected) {
        const label = await acct.locator('option:checked').first().textContent().catch(() => '');
        job.log(`Requested account: ${(label ?? '').trim()}`);
        return;
      }
      await sleep(500);
    }
    const options = await acct.locator('option').evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    if (options.length === 1) {
      await acct.selectOption({ value: options[0] });
      job.log('Selected the only requested account offered');
    } else {
      job.log('Requested account did not fill itself in; please choose it before submitting.');
    }
  });

  await step(job, page, 'Fill notes', async () => {
    const notes = f('notes');
    if (await notes.isVisible().catch(() => false)) await typeInto(notes, p.notes);
  });

  await step(job, page, 'Tick the terms checkbox', async () => {
    const cb = page.locator(cfg.form.terms).first();
    if (await cb.isVisible().catch(() => false)) {
      if (!(await cb.isChecked())) await cb.check();
    } else {
      job.log('Could not find the terms checkbox; please tick it yourself before submitting.');
    }
  });

  await screenshot(job, page, 'prefilled');
}

/**
 * Wait for the user to click Submit (or give up). Resolves with the Summit claim id when the
 * confirmation is seen, null when the browser was closed or the wait timed out.
 */
export async function waitForUserSubmit(page: Page, job: JobContext, timeoutMs: number): Promise<{ outcome: 'submitted' | 'closed' | 'timeout'; summitId: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { outcome: 'closed', summitId: null };
    try {
      const id = await cfg.detectConfirmation(page, cfg.paths.claimForm);
      if (id !== null) {
        await sleep(1500);
        await screenshot(job, page, 'confirmation');
        return { outcome: 'submitted', summitId: id || null };
      }
    } catch {
      /* navigation in progress */
    }
    await sleep(1500);
  }
  return { outcome: 'timeout', summitId: null };
}
