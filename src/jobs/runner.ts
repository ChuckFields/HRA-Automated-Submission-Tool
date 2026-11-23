import { EventEmitter } from 'node:events';
import { appendJobLog, createJobRun, getJobRun, updateJobRun } from '../db/repo.js';
import { nowIso } from '../util/dates.js';
import type { JobKind, JobRun, JobStatus } from '../types.js';

export interface JobContext {
  id: number;
  kind: JobKind;
  payload: unknown;
  log(line: string): void;
  progress(p: Record<string, unknown>): void;
  /** Flip the job into "waiting for you" with a message shown prominently in the dashboard. */
  waitingForUser(message: string): void;
  /** Back to running after the user did their part. */
  resume(message?: string): void;
  setScreenshot(path: string): void;
  setTrace(path: string): void;
  /** Register what to do if the user cancels (close the browser, say). */
  onCancel(fn: () => Promise<void> | void): void;
  cancelled: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<string | void>;

export interface JobEvent {
  type: 'job';
  job: JobRun;
  line?: string;
}

class JobRunner extends EventEmitter {
  private handlers = new Map<JobKind, JobHandler>();
  private queue: number[] = [];
  private current: number | null = null;
  private cancelHooks = new Map<number, Array<() => Promise<void> | void>>();
  readonly cancelledIds = new Set<number>();

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  isBusy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  currentJobId(): number | null {
    return this.current;
  }

  /** Cancel a queued or running job. Running jobs get their cancel hooks called (which usually closes the browser). */
  async cancel(id: number): Promise<boolean> {
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      updateJobRun(id, { status: 'failed', finished_at: nowIso(), error_message: 'Cancelled before it started' });
      this.emitJob(id);
      return true;
    }
    if (this.current !== id) return false;
    this.cancelledIds.add(id);
    updateJobRun(id, { message: 'Cancelling…' });
    this.emitJob(id);
    for (const fn of this.cancelHooks.get(id) ?? []) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  enqueue(kind: JobKind, payload?: unknown): JobRun {
    if (!this.handlers.has(kind)) throw new Error(`No handler registered for job kind ${kind}`);
    const job = createJobRun(kind, payload);
    this.queue.push(job.id);
    this.emitJob(job.id);
    void this.pump();
    return job;
  }

  private emitJob(id: number, line?: string): void {
    const job = getJobRun(id);
    if (job) this.emit('event', { type: 'job', job, line } satisfies JobEvent);
  }

  private async pump(): Promise<void> {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.current = next;
    try {
      await this.run(next);
    } finally {
      this.current = null;
      void this.pump();
    }
  }

  private async run(id: number): Promise<void> {
    const job = getJobRun(id)!;
    const handler = this.handlers.get(job.kind)!;
    const set = (patch: Parameters<typeof updateJobRun>[1]) => {
      updateJobRun(id, patch);
      this.emitJob(id);
    };
    const ctx: JobContext = {
      id,
      kind: job.kind,
      payload: job.payload_json ? JSON.parse(job.payload_json) : null,
      log: (line) => {
        const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
        appendJobLog(id, stamped);
        const j = getJobRun(id);
        if (j) this.emit('event', { type: 'job', job: j, line: stamped } satisfies JobEvent);
      },
      progress: (p) => set({ progress_json: JSON.stringify(p) }),
      waitingForUser: (message) => set({ status: 'waiting_for_user' as JobStatus, message }),
      resume: (message) => set({ status: 'running', message: message ?? null }),
      setScreenshot: (p) => set({ screenshot_path: p }),
      setTrace: (p) => set({ trace_path: p }),
      onCancel: (fn) => {
        if (!this.cancelHooks.has(id)) this.cancelHooks.set(id, []);
        this.cancelHooks.get(id)!.push(fn);
      },
      get cancelled() {
        return runner.cancelledIds.has(id);
      },
    };

    set({ status: 'running', started_at: nowIso(), message: null });
    ctx.log(`Job #${id} (${job.kind}) started`);
    try {
      const summary = await handler(ctx);
      ctx.log(summary ? `Done: ${summary}` : 'Done');
      set({ status: 'succeeded', finished_at: nowIso(), message: summary ?? null });
    } catch (err) {
      const e = err as Error;
      if (this.cancelledIds.has(id)) {
        ctx.log('Cancelled');
        set({ status: 'failed', finished_at: nowIso(), error_message: 'Cancelled by you', message: null });
      } else {
        ctx.log(`FAILED: ${e.message}`);
        if (e.stack) appendJobLog(id, e.stack.split('\n').slice(1, 6).join('\n'));
        set({ status: 'failed', finished_at: nowIso(), error_message: e.message, message: null });
      }
    } finally {
      this.cancelHooks.delete(id);
      this.cancelledIds.delete(id);
    }
  }
}

export const runner = new JobRunner();
