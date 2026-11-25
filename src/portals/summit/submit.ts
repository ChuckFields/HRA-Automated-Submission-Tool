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

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

/** True when Summit's "Unfinished Claims" list on the claim-form page already holds a draft with this description. */
export async function draftExists(page: Page, description: string): Promise<boolean> {
  // Show as many drafts as the list allows, so a long list does not hide the one we are looking for.
  const rows = page.locator('xpath=//*[normalize-space(text())="Unfinished Claims"]/following::select[1]').first();
  if (await rows.isVisible().catch(() => false)) {
    const current = await rows.inputValue().catch(() => '');
    if (current !== '50') {
      await rows.selectOption('50').catch(() => undefined);
      await sleep(1000);
    }
  }
  const text = squash(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
  const from = text.indexOf('Unfinished Claims');
  if (from < 0) return false;
  const to = text.indexOf('Claim History', from);
  return text.slice(from, to < 0 ? undefined : to).includes(squash(description));
}

/**
 * Click Summit's "Finish Later", which saves the filled form (attachment included) under "Unfinished Claims"
 * without submitting it. Throws unless the draft then shows up in that list.
 */
export async function saveAsDraft(page: Page, job: JobContext, description: string): Promise<void> {
  await step(job, page, 'Click "Finish Later" to save a draft', async () => {
    await page.locator('button:text-is("Finish Later"):visible').first().click();
    // Summit asks "save for later?" before it stores the draft.
    await page.locator('button:has-text("Yes, Save for Later"):visible').first().click({ timeout: 15_000 });
    // ...and then confirms with a second popup that only has an OK button.
    await page.locator('button:text-matches("^\\s*ok\\s*$", "i"):visible').first().click({ timeout: 15_000 }).catch(() => job.log('No OK popup appeared after saving the draft'));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await draftExists(page, description)) return;
    }
    throw new Error('Clicked "Finish Later" but the draft did not appear under Unfinished Claims');
  });
  await screenshot(job, page, 'draft-saved');
}

// ---------- drafts ("Unfinished Claims") ----------

/** One row of Summit's "Unfinished Claims" list, exactly as the portal shows it. */
export interface DraftRow {
  saved: string;
  start: string;
  end: string;
  description: string;
  amount: string;
}

/** What a draft holds once it is opened in the form. */
export interface DraftForm {
  claimant: string;
  start: string;
  end: string;
  amount: string;
  provider: string;
  category: string;
  code: string;
  description: string;
  account: string;
  notes: string;
  has_attachment: boolean;
}

/** The list is a grid of divs; a row is the element whose direct children carry "Description: ..." labels. */
const DRAFT_ROW = 'div:has(> [aria-label^="Description: "]):visible';

/** Open the claim form page (which also shows the Unfinished Claims list) with as many drafts visible as allowed. */
export async function openDraftList(page: Page): Promise<void> {
  // Right after a submission the portal is still navigating by itself, which can abort our own navigation.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(summitUrl(cfg.paths.claimForm), { waitUntil: 'domcontentloaded' });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(2000);
    }
  }
  await page.locator(cfg.form.submitButton).first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(2500);
  await draftExists(page, '\u0000'); // side effect: switches the list to 50 rows per page
}

export async function listDrafts(page: Page): Promise<DraftRow[]> {
  // No named helpers inside the callback: it runs in the page, where the bundler's helpers do not exist.
  const cells = await page.locator(DRAFT_ROW).evaluateAll((els) =>
    els.map((el) =>
      ['Date', 'Start', 'End', 'Description', 'Amount'].map((p) =>
        (el.querySelector(`:scope > [aria-label^="${p}: "]`)?.getAttribute('aria-label') ?? '').slice(p.length + 2).trim(),
      ),
    ),
  );
  return cells.map(([saved, start, end, description, amount]) => ({ saved, start, end, description, amount }));
}

/** Click Edit on the nth listed draft and wait for the form to show it. */
export async function openDraft(page: Page, index: number, row: DraftRow): Promise<DraftForm> {
  await page.locator(DRAFT_ROW).nth(index).locator('button:text-is("Edit")').first().click();
  const L = cfg.form.labels;
  const f = (k: keyof typeof L) => fieldAfterLabel(page, L[k].label, L[k].tag);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(750);
    const d = await f('description').inputValue().catch(() => '');
    const start = await f('serviceStart').inputValue().catch(() => '');
    if (squash(d) === squash(row.description) && start === row.start) break;
  }
  await sleep(1500); // dependent dropdowns (service code, requested account) settle after the rest
  const picked = (k: keyof typeof L) =>
    f(k).evaluate((el) => {
      const sel = el as HTMLSelectElement;
      return sel.value ? (sel.selectedOptions[0]?.textContent ?? '').trim() : '';
    }).catch(() => '');
  const value = (k: keyof typeof L) => f(k).inputValue().catch(() => '');
  const form: DraftForm = {
    claimant: await picked('claimant'),
    start: await value('serviceStart'),
    end: await value('serviceEnd'),
    amount: await value('amount'),
    provider: await value('provider'),
    category: await picked('category'),
    code: await picked('code'),
    description: await value('description'),
    account: await picked('account'),
    notes: await value('notes'),
    has_attachment: (await page.locator('button:text-is("Remove"):visible').count()) > 0,
  };
  if (squash(form.description) !== squash(row.description) || form.start !== row.start) {
    throw new Error(`Opened a draft but the form does not show it (expected "${row.description}", form has "${form.description}")`);
  }
  return form;
}

/**
 * Tick the terms box and click Submit Claim on the draft that is open in the form, answer Summit's standard
 * "are you sure?" box, then wait for its confirmation. Beyond that only a plain "OK" is ever clicked: any other
 * question Summit asks (a duplicate warning, say) is left on screen and reported, so nothing unexpected is
 * confirmed on the user's behalf.
 */
export async function submitOpenDraft(page: Page, job: JobContext): Promise<{ summitId: string | null }> {
  const cb = page.locator(cfg.form.terms).first();
  if (!(await cb.isChecked())) await cb.check();
  const formUrl = page.url();
  // Summit's standard "Confirm Submission: are you sure you want to submit this claim?" box must open before
  // anything is sent. A click made while the form is still settling is silently ignored, so try a few times;
  // until that box is answered nothing has been submitted, which makes the retry safe.
  const yes = page.locator('button:text-is("Yes, Submit Claim"):visible').first();
  let asked = false;
  for (let attempt = 1; attempt <= 4 && !asked; attempt++) {
    if (attempt > 1) {
      job.log(`  Submit Claim did not respond; trying again (${attempt}/4)`);
      await sleep(2500);
    }
    await page.locator(cfg.form.submitButton).locator('visible=true').first().click();
    asked = await yes.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
  }
  if (!asked) {
    await screenshot(job, page, 'draft-submit-no-confirm-box');
    throw new Error('Submit Claim never opened the confirmation box, so this draft was NOT submitted');
  }
  // Answered only when it is exactly that question; anything else is left on screen and reported below.
  const question = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  if (/are you sure you want to submit this claim\?/i.test(question)) await yes.click();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const id = await cfg.detectConfirmation(page, cfg.paths.claimForm).catch(() => null);
    if (id !== null) {
      await screenshot(job, page, 'draft-submitted');
      await page.locator('button:text-matches("^\\s*ok\\s*$", "i"):visible').first().click({ timeout: 3000 }).catch(() => undefined);
      return { summitId: id || null };
    }
  }
  await screenshot(job, page, 'draft-submit-unconfirmed');
  const visibleButtons = await page.locator('button:visible').allInnerTexts().catch(() => []);
  throw new Error(`Clicked Submit Claim but saw no confirmation within a minute (page ${page.url() === formUrl ? 'did not change' : 'changed'}; buttons on screen: ${visibleButtons.map(squash).filter(Boolean).join(' | ').slice(0, 300)})`);
}
