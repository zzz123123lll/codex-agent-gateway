import { z } from 'zod';

export class HubError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = 'HubError';
  }
}

export const requestSchema = z.object({
  provider: z.string().min(1).max(80).default('trae'),
  task: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).optional(),
  output: z.enum(['text', 'json', 'artifacts']).default('text'),
  idempotencyKey: z.string().min(1).max(200).optional(),
  constraints: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  timeoutSeconds: z.number().int().min(10).max(86_400).default(1_800)
}).strict();

export type RunInput = z.output<typeof requestSchema>;
export type RunRequestInput = z.input<typeof requestSchema>;
export type RunStatus = 'queued' | 'dispatching' | 'submitted' | 'running' | 'completed'
  | 'blocked' | 'failed' | 'cancel_requested' | 'cancelled' | 'uncertain';
export const waitingStates: ReadonlySet<RunStatus> = new Set(['queued', 'dispatching', 'submitted', 'running']);
export interface Artifact {
  name: string;
  path: string;
  bytes: number;
  sha256?: string;
}
export interface RunResult {
  text: string;
  artifacts: Artifact[];
  json?: unknown;
  digest?: string;
}
export interface HubRun {
  id: string;
  providerTaskId: string;
  input: RunInput;
  workspace: string;
  round: number;
  status: RunStatus;
  review: 'pending' | 'accepted';
  holdsCapacity: boolean;
  resultFile: string;
  result?: RunResult;
  previousAttemptId?: string;
  feedback?: string;
  attemptId?: string;
  sessionId?: string;
  runtimeSource?: string;
  error?: { code: string; message: string };
  lastPollError?: string;
  createdAt: string;
  updatedAt: string;
  deadline: string;
  usage: { credits: null; source: 'unavailable' };
}
export interface HubEvent {
  runId: string;
  id: number;
  createdAt: string;
  data: unknown;
  type: string;
}
export interface ProviderEvent {
  type: string;
  key: string;
  text: string;
}
export interface ProviderSnapshot {
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  events: ProviderEvent[];
  holdsCapacity: boolean;
  attemptId?: string;
  sessionId?: string;
  runtimeSource?: string;
  error?: string;
  accepted?: boolean; // Observed for protocol compatibility, never grants review authority.
}
export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: Record<string, unknown>;
  health(): Promise<{ state: string; message?: string; usage: HubRun['usage']; [key: string]: unknown }>;
  submit(task: HubRun): Promise<void>;
  poll(task: HubRun): Promise<ProviderSnapshot | undefined>;
  cancel(task: HubRun): Promise<void>;
  rework(task: HubRun): Promise<void>;
  accept(task: HubRun, evidence: { note: string; evidence: string[] }): Promise<void>;
  recover?(task: HubRun, reason: string): Promise<void>;
}
