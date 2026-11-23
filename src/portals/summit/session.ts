import type { Page } from 'playwright-core';
import { requireCredentials } from '../../security/credentials.js';
import { getSettings } from '../../db/repo.js';
import type { JobContext } from '../../jobs/runner.js';
import { isVisible, sleep, step, waitForAny } from '../shared/browser.js';
import { summitConfig as cfg } from './config.js';

export function summitUrl(p: string): string {
  const base = getSettings().summit_base_url.replace(/\/+$/, '');
  return p.startsWith('http') ? p : `${base}${p.startsWith('/') ? '' : '/'}${p}`;
}

export async function summitLoggedIn(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (await isVisible(page, cfg.login.password)) return false;
  return isVisible(page, cfg.loggedIn.selector);
}

/**
 * Get inside the Summit portal. Fills the username/password; the email-or-text verification code is
 * always the user's job, so the job flips to "waiting for you" when that screen appears.
 */
export async function ensureSummitLoggedIn(page: Page, job: JobContext): Promise<void> {
  await step(job, page, 'Open Summit portal', async () => {
    await page.goto(summitUrl(cfg.paths.home), { waitUntil: 'domcontentloaded' });
    await sleep(2500);
  });
  if (await summitLoggedIn(page)) {
    job.log('Already logged in to Summit (saved session)');
    return;
  }

  let autoFilled = false;
  await step(job, page, 'Log in to Summit', async () => {
    if (!(await isVisible(page, cfg.login.password))) {
      await page.goto(summitUrl(cfg.paths.login), { waitUntil: 'domcontentloaded' });
      await sleep(2000);
    }
    if (!(await isVisible(page, cfg.login.password))) {
      if (await summitLoggedIn(page)) return;
      job.waitingForUser('Please log in to Summit in the browser window. The app continues once you are in.');
      return;
    }
    const creds = requireCredentials('summit');
    await page.locator(cfg.login.username).first().fill(creds.username);
    await page.locator(cfg.login.password).first().fill(creds.password);
    await page.locator(cfg.login.submit).first().click();
    autoFilled = true;
  });

  const outcome = await step(job, page, 'Wait for Summit login to complete', async () => {
    let askedUser = false;
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const which = await waitForAny(
        page,
        {
          loggedIn: () => summitLoggedIn(page),
          mfa: () => isVisible(page, cfg.login.mfa),
          error: () => isVisible(page, cfg.login.error),
        },
        10_000,
      );
      if (which === 'loggedIn') return 'ok';
      if (which === 'closed') throw new Error('Browser window was closed before login finished');
      if (which === 'error' && autoFilled && !askedUser) {
        const text = (await page.locator(cfg.login.error).first().innerText().catch(() => '')).trim();
        if (/password|user ?name|invalid|incorrect|locked/i.test(text)) throw new Error(`Summit rejected the login: ${text}`);
      }
      if (which === 'mfa' && !askedUser) {
        askedUser = true;
        job.waitingForUser('Summit wants a verification code. In the browser window, choose email or text, enter the code, and the app will carry on.');
      }
    }
    return 'timeout';
  });
  if (outcome !== 'ok') throw new Error('Timed out waiting for the Summit login to finish (5 minutes)');
  job.resume('Logged in to Summit');
  job.log('Logged in to Summit');
}
