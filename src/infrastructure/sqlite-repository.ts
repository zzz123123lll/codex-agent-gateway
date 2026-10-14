import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubError, type HubRun, type HubEvent } from '../domain/contracts.js';

type RunRow = { body: string; fingerprint?: string };
type Audit = { type: string; data: unknown; key?: string };
export class HubStore {
  private readonly database: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.database.exec('PRAGMA journal_mode=WAL');
    this.database.exec('PRAGMA busy_timeout=5000');
    // This storage wire format is retained for existing installations, not copied implementation.
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS hub_runs (' +
      'id TEXT PRIMARY KEY, request_key TEXT UNIQUE, fingerprint TEXT NOT NULL, body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS hub_events (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_key TEXT, type TEXT NOT NULL,' +
      'data TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,event_key));' +
      'CREATE INDEX IF NOT EXISTS hub_events_run ON hub_events(run_id,id);'
    );
  }
  close(): void { this.database.close(); }
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  get(id: string): HubRun | undefined {
    const value = this.database.prepare('SELECT body FROM hub_runs WHERE id = ?').get(id) as RunRow | undefined;
    return value ? JSON.parse(value.body) as HubRun : undefined;
  }
  byKey(key: string, fingerprint: string): HubRun | undefined {
    const value = this.database.prepare('SELECT body, fingerprint FROM hub_runs WHERE request_key = ?').get(key) as RunRow | undefined;
    if (!value) return undefined;
    if (value.fingerprint !== fingerprint) throw new HubError('IDEMPOTENCY_CONFLICT', 'The idempotency key already identifies another request', 409);
    return JSON.parse(value.body) as HubRun;
  }
  create(task: HubRun, fingerprint: string): { run: HubRun; created: boolean } {
    return this.transaction(() => {
      const original = task.input.idempotencyKey ? this.byKey(task.input.idempotencyKey, fingerprint) : undefined;
      if (original) return { run: original, created: false };
      this.database.prepare('INSERT INTO hub_runs (id, request_key, fingerprint, body) VALUES (?, ?, ?, ?)')
        .run(task.id, task.input.idempotencyKey ?? null, fingerprint, JSON.stringify(task));
      this.appendState(task);
      return { run: task, created: true };
    });
  }
  list(limit = 100, offset = 0): HubRun[] {
    const values = this.database.prepare('SELECT body FROM hub_runs ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset) as RunRow[];
    return values.map(value => JSON.parse(value.body) as HubRun);
  }
  all(): HubRun[] {
    return (this.database.prepare('SELECT body FROM hub_runs ORDER BY rowid').all() as RunRow[])
      .map(value => JSON.parse(value.body) as HubRun);
  }
  save(task: HubRun, audit?: Audit): HubRun {
    const current = this.get(task.id);
    if (!current) throw new HubError('NOT_FOUND', 'Task does not exist', 404);
    if (!audit && JSON.stringify({ ...current, updatedAt: '' }) === JSON.stringify({ ...task, updatedAt: '' })) return current;
    const next = { ...task, updatedAt: new Date().toISOString() };
    return this.transaction(() => {
      this.database.prepare('UPDATE hub_runs SET body = ? WHERE id = ?').run(JSON.stringify(next), next.id);
      if (audit) this.event(next.id, audit.type, audit.data, audit.key);
      this.appendState(next);
      return next;
    });
  }
  event(runId: string, type: string, data: unknown, key?: string): void {
    this.database.prepare(
      'INSERT OR IGNORE INTO hub_events (run_id, event_key, type, data, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, key ?? null, type, JSON.stringify(data), new Date().toISOString());
  }
  private appendState(task: HubRun): void {
    const { id, status, review, round, holdsCapacity, attemptId, sessionId, runtimeSource, error, lastPollError, updatedAt } = task;
    this.event(id, 'state', { id, status, review, round, holdsCapacity, attemptId, sessionId, runtimeSource, error, lastPollError, updatedAt, resultAvailable: Boolean(task.result) });
  }
  events(runId: string, after = 0, limit = 100): HubEvent[] {
    const values = this.database.prepare(
      'SELECT id, run_id, type, data, created_at FROM hub_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?'
    ).all(runId, after, limit) as Array<{ id: number; run_id: string; type: string; data: string; created_at: string }>;
    return values.map(value => ({ id: value.id, runId: value.run_id, type: value.type, data: JSON.parse(value.data), createdAt: value.created_at }));
  }
}
