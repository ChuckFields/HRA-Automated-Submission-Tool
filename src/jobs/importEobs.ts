/**
 * Import EOB PDFs from a folder on this computer, as an alternative to "Fetch claims from IBX".
 * Payload: { folder: string, dry_run?: boolean }. A dry run parses and lists the claims without storing anything.
 */
import { getSettings } from '../db/repo.js';
import { describeEobImport, readEobFolder, writeEobImport } from '../services/eobImport.js';
import type { JobContext } from './runner.js';

export async function importEobsJob(job: JobContext): Promise<string> {
  const { folder, dry_run } = (job.payload ?? {}) as { folder: string; dry_run?: boolean };
  job.log(`Reading EOB PDFs in ${folder}`);
  const result = await readEobFolder(folder, getSettings().plan_year);
  describeEobImport(result, job.log);
  if (!result.claims.length) throw new Error('No claims could be read from the PDFs in that folder');
  const withWarnings = result.claims.filter((p) => p.warnings.length).length;
  const caution = withWarnings ? `; ${withWarnings} need a look (lines marked "!")` : '';
  if (dry_run) return `Preview only: ${result.claims.length} claims found in ${result.files} PDFs${caution}. Nothing was stored.`;
  const c = await writeEobImport(result);
  return `Imported ${result.claims.length} claims from ${result.files} PDFs: ${c.new} new, ${c.changed} changed, ${c.unchanged} unchanged${caution}`;
}
