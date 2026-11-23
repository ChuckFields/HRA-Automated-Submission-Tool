import type { Page } from 'playwright-core';
import { requireCredentials } from '../../security/credentials.js';
import { getSettings } from '../../db/repo.js';
import type { JobContext } from '../../jobs/runner.js';
import { isVisible, sleep, step, waitForAny } from '../shared/browser.js';
import { ibxConfig as cfg } from './config.js';

async function usernameBox(page: Page) {
  const css = page.locator(cfg.login.username).first();
  if (await css.isVisible().catch(() => false)) return css;
  const byRole = page.getByRole('textbox', { name: cfg.login.usernameRole }).first();
  if (await byRole.isVisible().catch(() => false)) return byRole;
  return null;
}

async function loggedIn(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (await isVisible(page, cfg.login.password)) return false;
  if (cfg.loggedIn.urlPattern.test(page.url())) return true;
  return isVisible(page, cfg.loggedIn.selector);
}

/** Make sure the page is inside the IBX member portal, logging in (and waiting for MFA) if needed. */
export async function ensureIbxLoggedIn(page: Page, job: JobContext): Promise<void> {
  const settings = getSettings();

  await step(job, page, 'Open IBX', async () => {
    // member.ibx.com answers 403 to anything but a real session, so start at the public login page.
    try {
      await page.goto(settings.ibx_member_url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      const reason = String((err as Error).message).split(/\r?\n/)[0];
      job.log(`Could not open ${settings.ibx_member_url} (${reason}); trying ${cfg.loginUrl}`);
      await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
    }
    await sleep(2500);
  });

  if (await loggedIn(page)) {
    job.log('Already logged in to IBX (saved session)');
    return;
  }

  let autoFilled = false;
  await step(job, page, 'Log in to IBX', async () => {
    let user = await usernameBox(page);
    if (!user) {
      // The public page shows a "Log in" button for members that leads to the real form.
      const memberLogin = page.locator(cfg.login.memberLoginLink).first();
      if (await memberLogin.isVisible().catch(() => false)) {
        await memberLogin.click();
        await sleep(4000);
        user = await usernameBox(page);
      }
    }
    if (!user) {
      if (await loggedIn(page)) return;
      job.log(`No login form found at ${page.url()}`);
      job.waitingForUser('Could not find the IBX login form, so please log in in the browser window. The app continues once you are in.');
      return;
    }
    const creds = requireCredentials('ibx');
    await user.fill(creds.username);
    const pw = page.locator(cfg.login.password).first();
    if (!(await pw.isVisible().catch(() => false))) {
      // Two-step login: submit the username first.
      await page.locator(cfg.login.submit).first().click();
      await pw.waitFor({ state: 'visible', timeout: 15_000 });
    }
    await pw.fill(creds.password);
    await page.locator(cfg.login.submit).first().click();
    job.log('Submitted the IBX login form');
    autoFilled = true;
  });

  const outcome = await step(job, page, 'Wait for IBX login to complete', async () => {
    let askedUser = false;
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const which = await waitForAny(
        page,
        {
          loggedIn: () => loggedIn(page),
          mfa: () => isVisible(page, cfg.mfa.selector),
          error: () => isVisible(page, cfg.login.error),
        },
        10_000,
      );
      if (which === 'loggedIn') return 'ok';
      if (which === 'closed') throw new Error('Browser window was closed before login finished');
      if (which === 'error' && autoFilled && !askedUser) {
        const text = (await page.locator(cfg.login.error).first().innerText().catch(() => '')).trim();
        if (/password|user ?name|invalid|incorrect/i.test(text)) throw new Error(`IBX rejected the login: ${text}`);
      }
      if (which === 'mfa' && !askedUser) {
        askedUser = true;
        job.waitingForUser('IBX is asking for a verification code. Enter it in the browser window (tick "remember this device" if offered).');
      }
    }
    return 'timeout';
  });
  if (outcome !== 'ok') throw new Error('Timed out waiting for the IBX login to finish (5 minutes)');
  job.resume('Logged in to IBX');
  job.log('Logged in to IBX');

  // Landing on member.ibx.com is not the end of the login: the app still exchanges the login for an access
  // token and stores it in sessionStorage a few seconds later. Nothing can be fetched until that exists.
  await step(job, page, 'Wait for the IBX session token', async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('Browser window was closed');
      const hasToken = await page
        .evaluate((key) => {
          try {
            return Boolean(JSON.parse(sessionStorage.getItem(key) || '{}').accessToken);
          } catch {
            return false;
          }
        }, cfg.claims.tokenStorageKey)
        .catch(() => false);
      if (hasToken) return;
      await sleep(1000);
    }
    throw new Error('Logged in, but the portal never issued a session token (waited 60 s). Try again; if it keeps happening, log out of IBX in the browser window and retry.');
  });
}
