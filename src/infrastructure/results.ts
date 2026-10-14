import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Artifact, HubRun, RunResult } from '../domain/contracts.js';

const outputEnvelope = z.object({
  text: z.string().trim().min(1),
  artifacts: z.array(z.string()).max(100),
  json: z.unknown().optional()
}).strict();
export function inside(root: string, candidate: string): boolean {
  const fragment = path.relative(root, candidate);
  return !path.isAbsolute(fragment) && fragment !== '..' && !fragment.startsWith('..' + path.sep);
}
export function workspacesOverlap(a: string, b: string): boolean {
  const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return inside(canonical(a), canonical(b)) || inside(canonical(b), canonical(a));
}
function unchangedRoots(roots: string[]): void {
  for (const root of roots) {
    if (path.relative(root, fs.realpathSync(root)) !== '') throw new Error('Authorized directory was replaced');
  }
}
function openAuthorized(file: string, roots: string[]): { fd: number; actual: string; roots: string[] } {
  if (!path.isAbsolute(file)) throw new Error('An absolute artifact path is required');
  unchangedRoots(roots);
  const actual = fs.realpathSync(file);
  if (!roots.some(root => inside(root, actual))) throw new Error('File escapes the authorized task directories');
  const fd = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('A regular file is required');
    const handle = { fd, actual, roots };
    checkIdentity(handle);
    return handle;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function checkIdentity(handle: { fd: number; actual: string; roots: string[] }): void {
  unchangedRoots(handle.roots);
  if (path.relative(handle.actual, fs.realpathSync(handle.actual)) !== '') throw new Error('File path was replaced');
  const opened = fs.fstatSync(handle.fd), current = fs.statSync(handle.actual);
  if (opened.dev !== current.dev || opened.ino !== current.ino || !current.isFile()) throw new Error('Opened file identity changed');
}
export function artifactFor(task: HubRun, candidate: string): Artifact {
  const handle = openAuthorized(candidate, [task.workspace, path.dirname(task.resultFile)]);
  try {
    const sha = createHash('sha256');
    const block = Buffer.allocUnsafe(65_536);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(handle.fd, block, 0, block.length, null);
      if (!count) break;
      bytes += count;
      sha.update(block.subarray(0, count));
    }
    checkIdentity(handle);
    return { name: path.basename(handle.actual), path: handle.actual, bytes, sha256: sha.digest('hex') };
  } finally {
    fs.closeSync(handle.fd);
  }
}
export function readResult(task: HubRun): RunResult {
  const handle = openAuthorized(task.resultFile, [path.dirname(task.resultFile)]);
  let bytes: Buffer;
  try {
    if (fs.fstatSync(handle.fd).size > 1_048_576) throw new Error('Result exceeds the 1 MiB limit');
    bytes = fs.readFileSync(handle.fd);
    if (bytes.length > 1_048_576) throw new Error('Result exceeds the 1 MiB limit');
    checkIdentity(handle);
  } finally { fs.closeSync(handle.fd); }
  const envelope = outputEnvelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const includesJson = Object.hasOwn(envelope, 'json');
  if (task.input.output === 'json' && !includesJson) throw new Error('Requested JSON result is missing');
  const files = Array.from(new Set(envelope.artifacts), file => artifactFor(task, file));
  if (task.input.output === 'artifacts' && files.length === 0) throw new Error('Requested artifacts are missing');
  return { text: envelope.text, artifacts: files, ...(includesJson ? { json: envelope.json } : {}), digest: createHash('sha256').update(bytes).digest('hex') };
}
