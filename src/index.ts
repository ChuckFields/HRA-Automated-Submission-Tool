import { exec } from 'node:child_process';
import net from 'node:net';
import Fastify from 'fastify';
import { db } from './db/db.js';
import { failStaleJobs } from './db/repo.js';
import { runner } from './jobs/runner.js';
import { fetchEobsJob } from './jobs/fetchEobs.js';
import { syncSummitJob } from './jobs/syncSummit.js';
import { prefillJob } from './jobs/prefill.js';
import { exploreJob } from './jobs/explore.js';
import { IS_SEA } from './util/paths.js';
import { registerApi } from './routes/api.js';
import { getAsset } from './web/assets.js';
import { DATA_DIR } from './util/paths.js';

async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('No free port found');
}

async function main(): Promise<void> {
  db();
  failStaleJobs();

  runner.register('fetch_eobs', fetchEobsJob);
  runner.register('sync_summit', syncSummitJob);
  runner.register('prefill', prefillJob);
  if (!IS_SEA) runner.register('explore', exploreJob);
  runner.register('noop', async (job) => {
    for (let i = 1; i <= 5; i++) {
      job.log(`Test job step ${i}/5`);
      job.progress({ step: i, of: 5 });
      await new Promise((r) => setTimeout(r, 400));
    }
    return 'Test job finished';
  });

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await registerApi(app);

  app.get('/', async (_req, reply) => {
    const a = getAsset('index.html')!;
    return reply.type(a.type).send(a.body);
  });
  app.get<{ Params: { file: string } }>('/:file', async (req, reply) => {
    const a = getAsset(req.params.file);
    if (!a) return reply.code(404).send('not found');
    return reply.type(a.type).header('Cache-Control', 'no-cache').send(a.body);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? (err.name === "ZodError" ? 400 : 500);
    reply.code(status).send({ error: err.message });
  });

  const port = await freePort(Number(process.env.PORT) || 3210);
  await app.listen({ port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${port}`;
  console.log(`HRA Automated Submission Tool running at ${url}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if ((IS_SEA || process.env.HRA_OPEN_BROWSER === "1") && process.env.HRA_NO_OPEN !== "1") {
    exec(`start "" "${url}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
