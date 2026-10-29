// GitHub Action mode (decision A12): maps INPUT_* to analyze, applies fail-on, writes GITHUB_OUTPUT, emits workflow
// annotations, and hands the output and cache directories back to the owner of the workspace (the action image runs
// as root, decision A15).
import { appendFileSync, chownSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyze, EXIT } from './analyze.ts';
import { canonical } from './util/canonical.ts';

function input(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim() || fallback;
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function chownTree(path: string, uid: number, gid: number): void {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  try {
    chownSync(path, uid, gid);
  } catch {
    return;
  }
  if (st.isDirectory()) for (const n of readdirSync(path)) chownTree(join(path, n), uid, gid);
}

export async function runGitHubAction(signal: AbortSignal): Promise<number> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const outputFile = process.env.GITHUB_OUTPUT;
  const path = input('path', '.');
  const output = input('output', 'intelligence-out');
  const config = input('config');
  const project = input('project');
  const failOn = input('fail-on', 'failed');
  if (!['failed', 'partial', 'never'].includes(failOn)) {
    process.stdout.write(`::error::fail-on must be failed, partial or never (got '${escapeData(failOn)}')\n`);
    return EXIT.usage;
  }
  const out = resolve(workspace, output);
  const cache = resolve(workspace, '.angular-intelligence');
  const code = await analyze({
    src: resolve(workspace, path),
    out,
    work: resolve(process.env.AI_WORK ?? '/work', 'analysis'),
    cache,
    config: config ? resolve(workspace, config) : null,
    project: project || null,
    includeWorkingTree: input('include-working-tree', 'false') === 'true',
    offline: false,
    noInstall: false,
    signal,
    emit: (e) => {
      if (e.event === 'diagnostic' && (e.severity === 'warning' || e.severity === 'error')) {
        process.stdout.write(`::${e.severity} title=${escapeProperty(String(e.code))}::${escapeData(`${e.scope ?? ''}: ${e.message}`)}\n`);
      } else if (e.event === 'stage.end') {
        process.stdout.write(`stage ${e.stage}: ${e.ms} ms\n`);
      }
    },
    log: (m) => process.stderr.write(m + '\n'),
  });
  const manifestPath = join(out, 'manifest.json');
  let status = 'failed';
  let coverage = '{}';
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    status = manifest.status;
    coverage = canonical(manifest.coverage.summary);
  }
  if (outputFile) {
    appendFileSync(outputFile, [`generation-path=${output}`, `manifest-path=${existsSync(manifestPath) ? `${output}/manifest.json` : ''}`, `status=${status}`, `coverage=${coverage}`].join('\n') + '\n');
  }
  // Hand files back to the workspace owner so later steps (upload, cache, cleanup) can manage them.
  try {
    const owner = statSync(workspace);
    chownTree(out, owner.uid, owner.gid);
    chownTree(cache, owner.uid, owner.gid);
  } catch {
    // not fatal: the step result does not depend on ownership
  }
  process.stdout.write(`angular-intelligence: status ${status}, exit code ${code}\n`);
  if (failOn === 'never') return 0;
  if (status === 'failed' || code === EXIT.integrity || code === EXIT.internal) return code === 0 ? 1 : code;
  if (failOn === 'partial' && status === 'partial') return code;
  return 0;
}
