import type { HubRun, ProviderSnapshot } from './contracts.js';

const observedStates = new Set(['dispatching', 'submitted', 'running', 'cancel_requested', 'uncertain']);
const finishedStates = new Set(['completed', 'failed', 'blocked', 'cancelled']);
export function needsObservation(task: HubRun): boolean {
  return task.status !== 'queued' && (task.holdsCapacity || observedStates.has(task.status));
}
export function permitsCorrection(task: HubRun): boolean {
  return !task.holdsCapacity && !!task.attemptId && finishedStates.has(task.status)
    && (task.status !== 'cancelled' || !!task.sessionId);
}
export function expired(task: HubRun): boolean {
  return Date.parse(task.deadline) <= Date.now();
}
export function deadline(seconds: number): string {
  return new Date(Date.now() + 1_000 * seconds).toISOString();
}
export function observe(task: HubRun, snapshot: ProviderSnapshot): HubRun {
  // Observations merge execution identity; executor review flags are deliberately ignored.
  const status = task.status === 'cancel_requested'
    ? snapshot.holdsCapacity ? 'cancel_requested' : 'cancelled'
    : snapshot.status === 'queued' ? 'submitted' : snapshot.status;
  return {
    ...task,
    status,
    holdsCapacity: snapshot.holdsCapacity,
    attemptId: snapshot.attemptId ?? task.attemptId,
    sessionId: snapshot.sessionId ?? task.sessionId,
    runtimeSource: snapshot.runtimeSource ?? task.runtimeSource,
    error: snapshot.error ? { code: 'PROVIDER_BLOCKED', message: snapshot.error } : undefined,
    lastPollError: undefined,
    ...(task.status === 'cancel_requested' ? { result: undefined } : {})
  };
}
