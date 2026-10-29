// Processes start with argument arrays (rule 1.4.8): text from the analysed repository is never interpolated into a shell.
import { spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
}

export function runSync(command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: options.timeoutMs,
    shell: false,
  });
  if (result.error) {
    return { code: 127, stdout: Buffer.alloc(0), stderr: String(result.error.message) };
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8') };
}

/** Runs a process asynchronously, streaming its output; used for installs, which can be long. */
export function runAsync(command: string, args: string[], options: RunOptions & { signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, signal: options.signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => resolve({ code: 127, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') + String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
  });
}
