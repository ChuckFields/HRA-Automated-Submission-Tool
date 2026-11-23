/**
 * Developer-only bridge: lets the person building the portal adapters drive the browser window that a running
 * job has open (e.g. the IBX recording mode) from outside the process, so the logged-in pages can be explored
 * without asking the user to click around. Never compiled into the packaged exe's routes (see routes/api.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { paths, safeName } from '../util/paths.js';

const pages = new Map<string, Page>();

export function registerBridgePage(name: string, page: Page): void {
  pages.set(name, page);
  page.on('close', () => {
    if (pages.get(name) === page) pages.delete(name);
  });
}

export function bridgePage(name: string): Page | null {
  const p = pages.get(name);
  return p && !p.isClosed() ? p : null;
}

export interface BridgeCommand {
  op: 'goto' | 'click' | 'fill' | 'text' | 'html' | 'links' | 'eval' | 'screenshot' | 'url' | 'wait' | 'select';
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  js?: string;
  ms?: number;
  name?: string;
}

export async function runBridge(name: string, cmd: BridgeCommand): Promise<unknown> {
  const page = bridgePage(name);
  if (!page) throw new Error(`No open bridge page named ${name}`);
  switch (cmd.op) {
    case 'goto':
      await page.goto(cmd.url!, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(cmd.ms ?? 2500);
      return { url: page.url() };
    case 'url':
      return { url: page.url(), title: await page.title() };
    case 'wait':
      await page.waitForTimeout(cmd.ms ?? 1000);
      return { url: page.url() };
    case 'click': {
      const loc = cmd.selector ? page.locator(cmd.selector).first() : page.getByText(cmd.text!, { exact: false }).first();
      await loc.click({ timeout: 10_000 });
      await page.waitForTimeout(cmd.ms ?? 2500);
      return { url: page.url() };
    }
    case 'fill':
      await page.locator(cmd.selector!).first().fill(cmd.value ?? '');
      return { ok: true };
    case 'select':
      await page.locator(cmd.selector!).first().selectOption(cmd.value ?? '');
      await page.waitForTimeout(cmd.ms ?? 1500);
      return { ok: true };
    case 'text':
      return { url: page.url(), text: await page.locator(cmd.selector ?? 'body').first().innerText() };
    case 'html': {
      const html = await page.content();
      const file = path.join(paths.discovery, 'ibx', 'snapshots', `${safeName(cmd.name ?? page.url().replace(/^https?:\/\//, '').slice(0, 80))}.html`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
      return { file, length: html.length };
    }
    case 'links':
      return await page.evaluate(() =>
        [...document.querySelectorAll('a, button, [role="link"], [role="button"], [routerlink]')].map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
          href: el.getAttribute('href') ?? el.getAttribute('routerlink') ?? el.getAttribute('ng-reflect-router-link'),
          id: el.id || undefined,
          cls: (el.getAttribute('class') ?? '').slice(0, 80) || undefined,
        })).filter((l) => l.text || l.href),
      );
    case 'eval':
      return await page.evaluate(cmd.js!);
    case 'screenshot': {
      const file = path.join(paths.discovery, 'ibx', 'snapshots', `${safeName(cmd.name ?? 'shot')}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: true });
      return { file };
    }
    default:
      throw new Error(`unknown op ${(cmd as BridgeCommand).op}`);
  }
}
