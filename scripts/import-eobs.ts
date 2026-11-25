/**
 * Command-line form of the Setup tab's "Import EOB PDFs" (see src/services/eobImport.ts).
 *   npx tsx scripts/import-eobs.ts <folder>           dry run: parse and print, touch nothing
 *   npx tsx scripts/import-eobs.ts <folder> --write   store claims, copy the PDFs into the data folder
 *   --year=2026 sets the plan year used for the eligibility estimate.
 */
import { describeEobImport, readEobFolder, writeEobImport } from '../src/services/eobImport.js';
import { paths } from '../src/util/paths.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith('--'));
  if (!folder) {
    console.error('Usage: npx tsx scripts/import-eobs.ts <folder of EOB PDFs> [--write] [--year=2026]');
    process.exit(2);
  }
  const result = await readEobFolder(folder, Number(args.find((a) => a.startsWith('--year='))?.slice(7)) || 2026);
  describeEobImport(result, (l) => console.log(l));
  if (!args.includes('--write')) {
    console.log('\nDry run: nothing was written. Re-run with --write to import.');
    return;
  }
  const c = await writeEobImport(result);
  console.log(`\nImported into ${paths.data}: ${c.new} new, ${c.changed} changed, ${c.unchanged} unchanged, ${c.copied} PDFs copied.`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
