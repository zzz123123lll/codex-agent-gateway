import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requestSchema, HubError, type AgentProvider, type HubRun } from '../domain/contracts.js';
import { deadline, expired, needsObservation, observe, permitsCorrection } from '../domain/lifecycle.js';
import { HubStore } from '../infrastructure/sqlite-repository.js';
import { readResult, workspacesOverlap } from '../infrastructure/results.js';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const digestRequest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Task command serialization is distinct from provider execution and persistent storage. */
export class HubEngine {
  readonly directory: string;
  readonly providers: Map<string, AgentProvider>;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly store: HubStore, adapters: AgentProvider[], directory: string, readonly maxConcurrent = 1) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error('Concurrency must be an integer between 1 and 16');
    this.providers = new Map();
    for (const adapter of adapters) {
      if (this.providers.has(adapter.id)) throw new Error('Duplicate provider identifier');
      this.providers.set(adapter.id, adapter);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = fs.realpathSync(directory);
  }

  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(action);
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }
  get(id: string): HubRun {
    const value = this.store.get(id);
    if (!value) throw new HubError('NOT_FOUND', 'Task does not exist', 404);
    return value;
  }
  provider(id: string): AgentProvider {
    const adapter = this.providers.get(id);
    if (!adapter) throw new HubError('PROVIDER_UNAVAILABLE', 'Requested executor is not configured', 400);
    return adapter;
  }
  async describeProviders() {
    return Promise.all(Array.from(this.providers.values(), async adapter => {
      const report = await adapter.health();
      return { id: adapter.id, label: adapter.label, capabilities: adapter.capabilities, ...report };
    }));
  }
  submit(request: unknown): { run: HubRun; created: boolean } {
    const normalized = requestSchema.parse(request);
    this.provider(normalized.provider);
    if (normalized.workspace) {
      try {
        if (!path.isAbsolute(normalized.workspace) || !fs.statSync(normalized.workspace).isDirectory()) throw new Error();
        normalized.workspace = fs.realpathSync(normalized.workspace);
      } catch {
        throw new HubError('INVALID_WORKSPACE', 'Workspace must be an existing absolute directory');
      }
    }
    const fingerprint = digestRequest(normalized);
    const earlier = normalized.idempotencyKey ? this.store.byKey(normalized.idempotencyKey, fingerprint) : undefined;
    if (earlier) return { run: earlier, created: false };
    if (this.store.all().filter(task => task.status === 'queued').length >= 100) throw new HubError('QUEUE_FULL', 'Pending task limit reached', 429);
    const id = 'hub-' + randomUUID();
    const workspace = normalized.workspace ?? path.join(this.directory, 'workspaces', id);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const record: HubRun = {
      id, providerTaskId: id, input: normalized, workspace: fs.realpathSync(workspace),
      round: 1, status: 'queued', review: 'pending', holdsCapacity: false,
      resultFile: this.allocateOutput(id, 1),
      createdAt: timestamp, updatedAt: timestamp, deadline: deadline(normalized.timeoutSeconds),
      usage: { credits: null, source: 'unavailable' }
    };
    return this.store.create(record, fingerprint);
  }
  private allocateOutput(id: string, round: number): string {
    const folder = path.join(this.directory, 'results', id, 'round-' + round);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return path.join(fs.realpathSync(folder), 'output.json');
  }
  private async refresh(record: HubRun): Promise<void> {
    try {
      const adapter = this.provider(record.input.provider);
      if (record.status === 'cancel_requested') await adapter.cancel(record);
      const snapshot = await adapter.poll(record);
      const staleRound = record.previousAttemptId && snapshot?.attemptId === record.previousAttemptId;
      if (!snapshot || staleRound) {
        this.store.save({
          ...record,
          status: record.status === 'cancel_requested' ? 'cancel_requested' : 'uncertain',
          holdsCapacity: true,
          error: { code: 'DISPATCH_UNCERTAIN', message: 'Current attempt cannot be confirmed; inspect the original executor before proceeding' }
        });
        return;
      }
      let merged = observe(record, snapshot);
      if (merged.status === 'completed') {
        try { merged = { ...merged, result: readResult(record) }; }
        catch (error) {
          merged = { ...merged, status: 'failed', error: { code: 'INVALID_OUTPUT', message: messageOf(error) }, result: undefined };
        }
      }
      // Result validation does not prove an executor has released its capacity.
      for (const event of snapshot.events) this.store.event(record.id, event.type, { text: event.text }, event.key);
      this.store.save(merged);
    } catch (error) {
      const timedOut = expired(record);
      this.store.save({
        ...record, lastPollError: messageOf(error),
        ...(timedOut ? {
          status: record.status === 'cancel_requested' ? 'cancel_requested' as const : 'blocked' as const,
          holdsCapacity: true,
          error: { code: 'DEADLINE_UNCONFIRMED', message: 'Deadline passed without confirmation that the executor stopped' }
        } : {})
      });
    }
  }
  tick(): Promise<void> {
    return this.exclusive(async () => {
      for (const task of this.store.all()) if (needsObservation(task)) await this.refresh(task);
      const pending = this.store.all().filter(task => task.status === 'queued');
      for (const candidate of pending) {
        if (expired(candidate)) {
          this.store.save({ ...candidate, status: 'failed', error: { code: 'QUEUE_TIMEOUT', message: 'Deadline expired in the queue; task was not dispatched' } });
          continue;
        }
        const occupied = this.store.all().filter(task => task.holdsCapacity);
        if (occupied.length >= this.maxConcurrent || occupied.some(task => workspacesOverlap(task.workspace, candidate.workspace))) continue;
        if (!this.providers.has(candidate.input.provider)) {
          this.store.save({ ...candidate, status: 'failed', error: { code: 'DISPATCH_NOT_SENT', message: 'Executor is not configured; no task was dispatched' } });
          continue;
        }
        const reservation = this.store.save({ ...candidate, status: 'dispatching', holdsCapacity: true });
        try {
          const adapter = this.provider(reservation.input.provider);
          if (reservation.previousAttemptId) await adapter.rework(reservation);
          else await adapter.submit(reservation);
        } catch (error) {
          if (error instanceof HubError && error.code === 'DISPATCH_NOT_SENT') {
            this.store.save({ ...this.get(reservation.id), status: 'failed', holdsCapacity: false, error: { code: error.code, message: error.message } });
            continue;
          }
          this.store.save({ ...this.get(reservation.id), lastPollError: messageOf(error) });
        }
        await this.refresh(this.get(reservation.id));
      }
    });
  }
  cancel(id: string): Promise<HubRun> {
    return this.exclusive(async () => {
      const task = this.get(id);
      if (!task.holdsCapacity && ['completed', 'failed', 'cancelled'].includes(task.status)) return task;
      if (task.status === 'queued') return this.store.save({ ...task, status: 'cancelled', holdsCapacity: false });
      const requested = this.store.save({ ...task, status: 'cancel_requested' });
      await this.refresh(requested);
      return this.get(id);
    });
  }
  rework(id: string, feedback: string): Promise<HubRun> {
    return this.exclusive(async () => {
      if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 100_000) throw new HubError('INVALID_FEEDBACK', 'Nonempty correction feedback is required');
      const task = this.get(id);
      const neverSent = task.status === 'failed' && ['DISPATCH_NOT_SENT', 'QUEUE_TIMEOUT'].includes(task.error?.code ?? '')
        && !task.holdsCapacity && !task.attemptId && !task.sessionId;
      if (!neverSent && !permitsCorrection(task)) throw new HubError('RUN_ACTIVE', 'Only a confirmed finished provider attempt may be reworked', 409);
      if (this.store.all().filter(record => record.status === 'queued').length >= 100) throw new HubError('QUEUE_FULL', 'Pending task limit reached', 429);
      const replacement: HubRun = {
        ...task, round: task.round + 1, status: 'queued', review: 'pending', holdsCapacity: false,
        feedback, previousAttemptId: neverSent ? undefined : task.attemptId,
        resultFile: this.allocateOutput(id, task.round + 1), result: undefined,
        error: undefined, lastPollError: undefined, deadline: deadline(task.input.timeoutSeconds)
      };
      const historical = {
        feedback, previousRound: task.round, round: replacement.round,
        previousReview: task.review, previousResultDigest: task.result?.digest,
        previousResultFile: task.resultFile, previousAttemptId: task.attemptId, sessionId: task.sessionId,
        ...(neverSent ? {
          previousErrorCode: task.error?.code,
          reason: task.error?.code === 'QUEUE_TIMEOUT' ? 'Task expired while queued; this round was never dispatched' : 'Provider confirmed no prompt was sent'
        } : {})
      };
      return this.store.save(replacement, { type: neverSent ? 'dispatch_retry' : 'rework', data: historical });
    });
  }
  accept(id: string, evidence: { note: string; evidence: string[] }): Promise<HubRun> {
    return this.exclusive(async () => {
      const task = this.get(id);
      if (task.status !== 'completed' || task.holdsCapacity) throw new HubError('NOT_REVIEWABLE', 'A valid finished result is required for review', 409);
      if (!task.result?.digest) throw new HubError('LEGACY_RESULT', 'Legacy output lacks its completion digest; rework and independently review it', 409);
      let current;
      try { current = readResult(task); }
      catch { throw new HubError('OUTPUT_CHANGED', 'Output changed or became unavailable after completion', 409); }
      if (!isDeepStrictEqual(current, task.result)) throw new HubError('OUTPUT_CHANGED', 'Output changed since completion; repeat independent verification', 409);
      if (task.review === 'accepted') return task;
      if (!evidence || typeof evidence.note !== 'string' || !evidence.note.trim()
        || !Array.isArray(evidence.evidence) || !evidence.evidence.length
        || evidence.evidence.some(item => typeof item !== 'string' || !item.trim())) {
        throw new HubError('EVIDENCE_REQUIRED', 'Provide concrete independent verification evidence and a review note');
      }
      await this.provider(task.input.provider).accept(task, evidence);
      return this.store.save({ ...task, review: 'accepted' }, { type: 'review', data: evidence });
    });
  }
  recover(id: string, reason: string): Promise<HubRun> {
    return this.exclusive(async () => {
      const task = this.get(id);
      if (!['uncertain', 'blocked'].includes(task.status) || !task.holdsCapacity || typeof reason !== 'string' || !reason.trim()) {
        throw new HubError('NOT_RECOVERABLE', 'Inspect an uncertain or blocked attempt and provide the recovery reason', 409);
      }
      const adapter = this.provider(task.input.provider);
      if (!adapter.recover) throw new HubError('RECOVERY_UNAVAILABLE', 'Executor does not implement checked recovery', 409);
      await adapter.recover(task, reason);
      this.store.event(id, 'recovery', { reason, taskCompleted: false });
      await this.refresh(task);
      return this.get(id);
    });
  }
}
