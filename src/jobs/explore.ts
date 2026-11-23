/**
 * Developer-only: open a portal, log in, and keep the window open so the page bridge can drive it.
 * Ends when cancelled or after 30 minutes. Not reachable in the packaged exe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchPortal, sleep } from '../portals/shared/browser.js';
import { paths } from '../util/paths.js';
import { ensureIbxLoggedIn } from '../portals/ibx/session.js';
import { ensureSummitLoggedIn } from '../portals/summit/session.js';
import { registerBridgePage } from '../dev/pageBridge.js';
import type { JobContext } from './runner.js';

export async function exploreJob(job: JobContext): Promise<string> {
  const { portal } = (job.payload ?? {}) as { portal: 'ibx' | 'summit' };
  const session = await launchPortal(portal, job);
  registerBridgePage(portal, session.page);
  session.context.on('page', (p) => registerBridgePage(portal, p));
  // Log every API call (method, url, request body, response size) so request shapes can be copied exactly.
  const logFile = path.join(paths.discovery, portal, 'explore-requests.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  session.context.on('response', async (res) => {
    try {
      const req = res.request();
      if (!/\/mdx\/|\/api\//.test(res.url()) || /\.(js|css|png|svg|woff2?|ttf)(\?|$)/.test(res.url())) return;
      const text = await res.text().catch(() => '');
      fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), method: req.method(), url: res.url(), status: res.status(), postData: req.postData(), responseLen: text.length, responseHead: text.slice(0, 300) }) + '\n');
    } catch {
      /* ignore */
    }
  });
  try {
    if (portal === 'ibx') await ensureIbxLoggedIn(session.page, job);
    else await ensureSummitLoggedIn(session.page, job);
    job.waitingForUser(`Developer exploration: ${portal} is open and being driven from the terminal.`);
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !job.cancelled && !session.page.isClosed()) await sleep(1000);
    if (job.cancelled) throw new Error('cancelled');
    job.resume();
    return 'Exploration window closed';
  } finally {
    await session.finish(true);
  }
}
