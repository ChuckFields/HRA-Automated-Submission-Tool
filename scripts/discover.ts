/**
 * Discovery helper: opens a portal in a headed browser using the SAME persistent profile the app uses,
 * records every network response (HAR + JSON bodies) and lets you snapshot pages while you click around.
 *
 *   npm run discover:ibx
 *   npm run discover:summit
 *
 * Output goes to data/discovery/<portal>/. Nothing here is automated: you log in and browse by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type BrowserContext } from 'playwright-core';
import { findPlaywrightChromium } from '../src/portals/shared/browser.js';
import { getSettings } from '../src/db/repo.js';
import { paths, safeName } from '../src/util/paths.js';

const portal = process.argv[2] as 'ibx' | 'summit';
if (portal !== 'ibx' && portal !== 'summit') {
  console.error('Usage: tsx scripts/discover.ts <ibx|summit>');
  process.exit(1);
}

const settings = getSettings();
const startUrl = portal === 'ibx' ? settings.ibx_member_url : settings.summit_base_url;
const outDir = path.join(paths.discovery, portal);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(path.join(outDir, 'responses'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'snapshots'), { recursive: true });

const CHECKLIST: Record<string, string[]> = {
  ibx: [
    'Log in. If asked for a verification code, enter it and tick "remember this device".',
    `Open the Claims section. Set the date range to ${settings.plan_year}.`,
    'If there is a member filter, cycle through EVERY covered family member and page through all results.',
    'Open one claim detail page. Type  snap claim-detail  here and press Enter.',
    'Download / view the EOB PDF for one claim per family member.',
    'If any claim was adjusted or reprocessed, open it too.',
    'Type  q  and press Enter when done.',
  ],
  summit: [
    'Log in (note whether a security image, passphrase or security question appears).',
    'Open Transaction Activity / claims history. Type  snap activity  here and press Enter.',
    'Open one previously submitted claim. Type  snap activity-detail  and press Enter.',
    'Open "Enter a Claim". Type  snap claim-form  and press Enter. Then CANCEL — do not submit.',
    'Type  q  and press Enter when done.',
  ],
};

const skipTypes = /image|font|css|javascript|octet-stream|video/;
let n = 0;
const log: string[] = [];

async function launch(): Promise<BrowserContext> {
  const profile = paths.profile(portal);
  fs.mkdirSync(profile, { recursive: true });
  const opts = {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ['--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
    recordHar: { path: path.join(outDir, `session-${stamp}.har`), content: 'embed' as const },
  };
  try {
    return await chromium.launchPersistentContext(profile, { ...opts, channel: 'msedge' });
  } catch (err) {
    const exe = findPlaywrightChromium();
    if (!exe) throw err;
    console.log(`Falling back to Playwright Chromium at ${exe}`);
    return await chromium.launchPersistentContext(profile, { ...opts, executablePath: exe });
  }
}

async function main(): Promise<void> {
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());

  context.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] ?? '';
      const url = res.url();
      if (skipTypes.test(ct)) return;
      const req = res.request();
      const line = `${res.status()} ${req.method()} ${url} [${ct.split(';')[0]}]`;
      log.push(line);
      if (/json/.test(ct) || req.method() !== 'GET') {
        const body = await res.text().catch(() => '');
        if (body.length < 50) return;
        n += 1;
        const file = path.join(outDir, 'responses', `${String(n).padStart(4, '0')}_${safeName(url.replace(/^https?:\/\//, '').slice(0, 90))}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify({ url, method: req.method(), status: res.status(), contentType: ct, postData: req.postData(), requestHeaders: req.headers(), body: tryParse(body) }, null, 2),
        );
        console.log(`  captured ${path.basename(file)}`);
      }
      if (/pdf/.test(ct)) console.log(`  PDF response: ${url}`);
    } catch {
      /* ignore */
    }
  });
  page.on('download', (d) => console.log(`  download event: ${d.url()} -> ${d.suggestedFilename()}`));
  context.on('page', (p) => {
    console.log(`  new tab: ${p.url()}`);
    p.on('download', (d) => console.log(`  download event: ${d.url()} -> ${d.suggestedFilename()}`));
  });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`(initial navigation: ${e.message})`));

  console.log(`\n=== ${portal.toUpperCase()} discovery ===`);
  console.log(`Recording to ${outDir}\n`);
  CHECKLIST[portal].forEach((s, i) => console.log(`${i + 1}. ${s}`));
  console.log('\nCommands:  snap <name>   save HTML + screenshot of the current page\n           q             finish\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((r) => rl.question('> ', r));
  for (;;) {
    const cmd = (await ask()).trim();
    if (cmd === 'q' || cmd === 'quit') break;
    if (cmd.startsWith('snap')) {
      const name = safeName(cmd.slice(4).trim() || `page-${Date.now()}`);
      const current = context.pages().at(-1) ?? page;
      try {
        fs.writeFileSync(path.join(outDir, 'snapshots', `${name}.html`), await current.content());
        await current.screenshot({ path: path.join(outDir, 'snapshots', `${name}.png`), fullPage: true });
        fs.writeFileSync(path.join(outDir, 'snapshots', `${name}.url.txt`), current.url());
        console.log(`  saved snapshots/${name}.html + .png (${current.url()})`);
      } catch (e) {
        console.log(`  snapshot failed: ${(e as Error).message}`);
      }
    }
  }
  rl.close();
  fs.writeFileSync(path.join(outDir, `requests-${stamp}.log`), log.join('\n'));
  await context.close();
  console.log(`Done. ${n} JSON responses captured; request log and HAR written to ${outDir}`);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s.slice(0, 20_000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
