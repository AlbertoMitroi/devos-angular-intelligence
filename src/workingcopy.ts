// Working copy (PLAN 3.1): the committed state is exported from Git objects (ls-tree + cat-file --batch),
// so bytes and blob ids are the committed ones on every host OS (decision A7).
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSync } from './util/proc.ts';
import { gitBlobId } from './util/canonical.ts';

export interface WorkingCopy {
  root: string;
  commit: string;
  objectFormat: 'sha1' | 'sha256';
  remoteUrl: string | null;
  dirty: boolean;
  /** Repository-relative path (forward slashes) to Git blob id. */
  blobs: Map<string, string>;
  diagnostics: { code: string; scope: string; state: 'failed' | 'partial' | 'unsupported' | 'unknown'; severity: 'info' | 'warning' | 'error'; message: string }[];
}

export class WorkingCopyError extends Error {}

function git(src: string, args: string[], input?: string): Buffer {
  const result = runSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotePath=false', '-C', src, ...args], {
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: process.env.HOME ?? '/tmp' },
  });
  if (result.code !== 0) throw new WorkingCopyError(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Removes credentials from a remote URL (user:password@host, tokens in https URLs). */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/');

export function exportWorkingCopy(src: string, target: string, includeWorkingTree: boolean): WorkingCopy {
  if (!existsSync(src)) throw new WorkingCopyError(`source '${src}' does not exist`);
  let commit: string;
  try {
    commit = git(src, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  } catch (e) {
    throw new WorkingCopyError(`'${src}' is not a Git repository with a commit: ${(e as Error).message}`);
  }
  let objectFormat: 'sha1' | 'sha256' = 'sha1';
  try {
    objectFormat = git(src, ['rev-parse', '--show-object-format']).toString('utf8').trim() === 'sha256' ? 'sha256' : 'sha1';
  } catch {
    objectFormat = 'sha1';
  }
  let remoteUrl: string | null = null;
  try {
    const url = git(src, ['config', '--get', 'remote.origin.url']).toString('utf8').trim();
    remoteUrl = url ? stripCredentials(url) : null;
  } catch {
    remoteUrl = null;
  }
  const wc: WorkingCopy = { root: target, commit, objectFormat, remoteUrl, dirty: includeWorkingTree, blobs: new Map(), diagnostics: [] };
  mkdirSync(target, { recursive: true });

  const listing = git(src, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8').split('\0').filter((l) => l.length > 0);
  const regular: { path: string; oid: string; mode: string }[] = [];
  for (const line of listing) {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    if (type === 'commit') {
      wc.diagnostics.push({ code: 'submodule-not-analyzed', scope: path, state: 'unsupported', severity: 'warning', message: `Submodule '${path}' (${oid}) is not analysed.` });
      continue;
    }
    if (mode === '120000') {
      wc.diagnostics.push({ code: 'symlink-skipped', scope: path, state: 'unsupported', severity: 'info', message: `Symbolic link '${path}' is not followed.` });
      continue;
    }
    if (type === 'blob') regular.push({ path, oid, mode });
  }

  if (includeWorkingTree) {
    const files = git(src, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter((l) => l.length > 0);
    const linked = new Set(listing.filter((l) => l.startsWith('120000 ') || l.includes(' commit ')).map((l) => l.slice(l.indexOf('\t') + 1)));
    for (const path of files.sort()) {
      if (linked.has(path)) continue;
      const full = join(src, path);
      if (!existsSync(full) || !lstatSync(full).isFile()) continue;
      const bytes = readFileSync(full);
      writeFile(target, path, bytes);
      wc.blobs.set(path, gitBlobId(bytes, objectFormat));
    }
    return wc;
  }

  // One cat-file process for all blobs; output is "<oid> blob <size>\n<bytes>\n" per object.
  const out = git(src, ['cat-file', '--batch'], regular.map((r) => r.oid).join('\n') + '\n');
  let offset = 0;
  for (const entry of regular) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString('utf8').split(' ');
    if (header[1] === 'missing') {
      throw new WorkingCopyError(`blob ${entry.oid} for '${entry.path}' is missing from the object store`);
    }
    const size = Number(header[2]);
    const bytes = out.subarray(newline + 1, newline + 1 + size);
    offset = newline + 1 + size + 1;
    if (bytes.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) {
      wc.diagnostics.push({ code: 'lfs-pointer', scope: entry.path, state: 'unsupported', severity: 'info', message: `'${entry.path}' is a Git LFS pointer; its content is not resolved.` });
    }
    writeFile(target, entry.path, bytes);
    wc.blobs.set(entry.path, entry.oid);
  }
  return wc;
}

function writeFile(root: string, path: string, bytes: Uint8Array): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}
