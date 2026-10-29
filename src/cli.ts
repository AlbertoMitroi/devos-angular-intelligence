#!/usr/bin/env node
// Entry point: version, preflight, analyze, verify, query, gha (GitHub Action mode, decision A12).
import { join, resolve } from 'node:path';
import { analyze, EXIT } from './analyze.ts';
import { verifyGeneration } from './artifacts/generation.ts';
import { query } from './artifacts/query.ts';
import { sqliteInfo } from './artifacts/sqlite.ts';
import { ENGINE_NAME, ENGINE_VERSION } from './model.ts';
import { engineTypeScriptVersion, engineAngularCompilerVersion } from './toolchain.ts';
import { exportWorkingCopy } from './workingcopy.ts';
import { discover } from './discovery.ts';
import { planInstall } from './install.ts';
import { canonical, compareOrdinal } from './util/canonical.ts';
import { runGitHubAction } from './gha.ts';

const USAGE = `${ENGINE_NAME} ${ENGINE_VERSION}
Usage:
  version [--json]
  preflight --src <repo> [--json]
  analyze --src <repo> --out <dir> [--config <file>] [--project <name|path>] [--include-working-tree] [--offline] [--no-install]
  verify <generation>
  query <generation> <symbol|refs|callers|callees|impl|di|routes|http|search|dump> [args] [--json]
  gha   (GitHub Action mode; reads INPUT_* variables)`;

function option(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

export function versionInfo(): Record<string, unknown> {
  const sqlite = sqliteInfo();
  return {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    node: process.version,
    typescript: engineTypeScriptVersion(),
    angularCompiler: engineAngularCompilerVersion(),
    sqlite: sqlite.version,
    fts5: sqlite.fts5,
    imageDigest: process.env.AI_IMAGE_DIGEST ?? 'unknown',
    platform: `${process.platform}/${process.arch}`,
  };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  switch (command) {
    case 'version': {
      const info = versionInfo();
      process.stdout.write(args.includes('--json') ? canonical(info) + '\n' : Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');
      return info.fts5 ? 0 : EXIT.internal;
    }
    case 'preflight': {
      const src = option(args, '--src');
      if (!src) break;
      const work = resolve(process.env.AI_WORK ?? '/work', 'preflight');
      const wc = exportWorkingCopy(src, join(work, 'repo'), args.includes('--include-working-tree'));
      const d = discover(wc.root, [...wc.blobs.keys()].sort(compareOrdinal));
      const roots = [...new Set(d.projects.map((p) => p.installRoot))].sort(compareOrdinal);
      const result = {
        commit: wc.commit,
        remoteUrl: wc.remoteUrl,
        node: process.version,
        projects: d.projects.map((p) => ({ name: p.name, path: p.path, kind: p.kind, projectType: p.projectType, tsConfig: p.tsConfig, installRoot: p.installRoot })),
        installs: roots.map((r) => {
          const plan = planInstall(wc.root, r, args.includes('--offline'));
          return { root: r, manager: plan.manager, lockfile: plan.lockfile, command: plan.command };
        }),
        problems: [...d.problems, ...wc.diagnostics],
      };
      process.stdout.write(args.includes('--json') ? canonical(result) + '\n' : JSON.stringify(result, null, 2) + '\n');
      return d.projects.length > 0 ? 0 : EXIT.nothing;
    }
    case 'analyze': {
      const src = option(args, '--src');
      const out = option(args, '--out');
      if (!src || !out) break;
      return analyze({
        src: resolve(src),
        out: resolve(out),
        work: resolve(process.env.AI_WORK ?? '/work', 'analysis'),
        cache: resolve(process.env.AI_CACHE ?? '/cache'),
        config: option(args, '--config'),
        project: option(args, '--project'),
        includeWorkingTree: args.includes('--include-working-tree'),
        offline: args.includes('--offline'),
        noInstall: args.includes('--no-install'),
        signal: controller.signal,
        emit: (e) => process.stdout.write(canonical(e) + '\n'),
        log: (m) => process.stderr.write(m + '\n'),
      });
    }
    case 'verify': {
      const dir = args[0];
      if (!dir) break;
      const result = verifyGeneration(resolve(dir));
      for (const n of result.notes) process.stdout.write(`note: ${n}\n`);
      for (const e of result.errors) process.stdout.write(`error: ${e}\n`);
      process.stdout.write(result.ok ? 'verify: ok\n' : `verify: failed (${result.errors.length} error(s))\n`);
      return result.ok ? 0 : EXIT.integrity;
    }
    case 'query': {
      const [dir, ...rest] = args;
      if (!dir || rest.length === 0) break;
      const r = query(resolve(dir), rest);
      process.stdout.write((rest.includes('--json') ? canonical(r.json) : r.text) + '\n');
      return r.code;
    }
    case 'gha':
      return runGitHubAction(controller.signal);
    case '--help':
    case 'help':
    case undefined:
      process.stdout.write(USAGE + '\n');
      return command === undefined ? EXIT.usage : 0;
  }
  process.stderr.write(USAGE + '\n');
  return EXIT.usage;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`internal error: ${(e as Error).stack ?? e}\n`);
      process.exit(EXIT.internal);
    },
  );
}
