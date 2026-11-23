import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { paths, safeName } from '../../util/paths.js';
import type { JobContext } from '../../jobs/runner.js';

export interface PortalSession {
  context: BrowserContext;
  page: Page;
  /** Close the browser. Pass ok=false to keep a trace zip for debugging. */
  finish(ok: boolean): Promise<void>;
}

/** Find the Chromium that `npx playwright install chromium` put under %LOCALAPPDATA%, if any. */
export function findPlaywrightChromium(): string | null {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
  if (!base || !fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-win', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
    const exe64 = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe64)) return exe64;
  }
  return null;
}

export async function launchPortal(portal: 'ibx' | 'summit', job: JobContext): Promise<PortalSession> {
  const profileDir = paths.profile(portal);
  fs.mkdirSync(profileDir, { recursive: true });

  const common = {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // Edge ships with Windows; fall back to Chrome, then to a Playwright-installed Chromium.
  let context: BrowserContext | null = null;
  const errors: string[] = [];
  for (const channel of ['msedge', 'chrome'] as const) {
    try {
      context = await chromium.launchPersistentContext(profileDir, { ...common, channel });
      job.log(`Opened ${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'} (profile: ${profileDir})`);
      break;
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  if (!context) {
    const exe = findPlaywrightChromium();
    if (!exe) throw new Error(`No browser could be started. Install Microsoft Edge or Google Chrome. (${errors.join('; ')})`);
    job.log(`Edge/Chrome unavailable, using Playwright Chromium at ${exe}`);
    context = await chromium.launchPersistentContext(profileDir, { ...common, executablePath: exe });
  }

  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(45_000);
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
  } catch {
    /* tracing is best-effort */
  }
  const page = context.pages()[0] ?? (await context.newPage());
  job.onCancel(async () => {
    job.log('Cancel requested; closing the browser window');
    await context.close().catch(() => undefined);
  });

  return {
    context,
    page,
    async finish(ok: boolean) {
      try {
        if (ok) {
          await context.tracing.stop();
        } else {
          const tracePath = path.join(paths.traces, `${job.id}.zip`);
          await context.tracing.stop({ path: tracePath });
          job.setTrace(tracePath);
        }
      } catch {
        /* ignore */
      }
      try {
        await context.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Run one named portal step; on failure capture a screenshot and rethrow with context. */
export async function step<T>(job: JobContext, page: Page, name: string, fn: () => Promise<T>): Promise<T> {
  job.log(`• ${name}`);
  try {
    return await fn();
  } catch (err) {
    let where = '';
    try {
      if (!page.isClosed()) {
        where = ` (at ${page.url()})`;
        const file = path.join(paths.screenshots, `${job.id}_${safeName(name)}.png`);
        await page.screenshot({ path: file, fullPage: true });
        job.setScreenshot(file);
      }
    } catch {
      /* ignore screenshot failures */
    }
    const msg = (err as Error).message.split('\n')[0];
    throw new Error(`${name}: ${msg}${where}`);
  }
}

export async function screenshot(job: JobContext, page: Page, label: string): Promise<string | null> {
  try {
    const file = path.join(paths.screenshots, `${job.id}_${safeName(label)}.png`);
    await page.screenshot({ path: file, fullPage: true });
    job.setScreenshot(file);
    return file;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until any of the named conditions is true. Returns which one, or 'timeout'. */
export async function waitForAny(
  page: Page,
  checks: Record<string, () => Promise<boolean>>,
  timeoutMs: number,
  pollMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return 'closed';
    for (const [name, check] of Object.entries(checks)) {
      try {
        if (await check()) return name;
      } catch {
        /* transient DOM errors during navigation */
      }
    }
    await sleep(pollMs);
  }
  return 'timeout';
}

export async function isVisible(page: Page, selector: string | null | undefined): Promise<boolean> {
  if (!selector) return false;
  try {
    return await page.locator(selector).first().isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

export class NotConfiguredError extends Error {
  constructor(portal: string, what: string) {
    super(
      `${portal}: ${what} has not been configured yet. Run the discovery script (npm run discover:${portal.toLowerCase()}) ` +
        `and fill in src/portals/${portal.toLowerCase()}/config.ts.`,
    );
  }
}
