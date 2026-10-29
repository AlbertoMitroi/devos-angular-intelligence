// Install (PLAN 3.1): the package manager is chosen by lockfile; scripts never run (--ignore-scripts, spike S3);
// the package cache lives in /cache. Credentials come only from the environment and never reach outputs.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runAsync } from './util/proc.ts';
import { redactLine } from './secrets.ts';
import { stripCredentials } from './workingcopy.ts';
import { compareOrdinal } from './util/canonical.ts';

export type Manager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry';

export interface InstallPlan {
  root: string;
  manager: Manager;
  lockfile: string | null;
  command: string[];
}

export interface InstallResult extends InstallPlan {
  code: number;
  message: string;
  retried: boolean;
  durationMs: number;
}

export function planInstall(workRoot: string, root: string, offline: boolean): InstallPlan {
  const dir = join(workRoot, root);
  const at = (f: string) => existsSync(join(dir, f));
  const npmBase = ['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...(offline ? ['--offline'] : [])];
  if (at('package-lock.json') || at('npm-shrinkwrap.json')) {
    return { root, manager: 'npm', lockfile: at('package-lock.json') ? 'package-lock.json' : 'npm-shrinkwrap.json', command: ['npm', 'ci', ...npmBase] };
  }
  if (at('pnpm-lock.yaml')) {
    return { root, manager: 'pnpm', lockfile: 'pnpm-lock.yaml', command: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', ...(offline ? ['--offline'] : [])] };
  }
  if (at('yarn.lock')) {
    if (at('.yarnrc.yml')) return { root, manager: 'yarn-berry', lockfile: 'yarn.lock', command: ['corepack', 'yarn', 'install', '--immutable', '--mode=skip-build'] };
    return { root, manager: 'yarn', lockfile: 'yarn.lock', command: ['corepack', 'yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive', ...(offline ? ['--offline'] : [])] };
  }
  return { root, manager: 'npm', lockfile: null, command: ['npm', 'install', '--no-package-lock', ...npmBase] };
}

/** Last lines of an install log, redacted (tokens, URL credentials). */
export function tail(text: string, lines = 12): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    // npm log paths carry a timestamp; they are dropped so the message is identical across runs.
    .filter((l) => l.length > 0 && !/^npm (notice|warn deprecated)/.test(l) && !/complete log of this run|\/_logs\/|eresolve-report/.test(l))
    .slice(-lines)
    .map((l) => stripCredentials(redactLine(l)).replace(/(_authToken|_auth|token)=\S+/gi, '$1=[redacted]'))
    .join('\n');
}

export async function install(workRoot: string, plan: InstallPlan, cacheDir: string, signal?: AbortSignal): Promise<InstallResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(cacheDir, 'npm'),
    npm_config_update_notifier: 'false',
    COREPACK_HOME: join(cacheDir, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    YARN_CACHE_FOLDER: join(cacheDir, 'yarn'),
    YARN_ENABLE_SCRIPTS: 'false',
    npm_config_store_dir: join(cacheDir, 'pnpm'),
    CI: 'true',
  };
  const started = Date.now();
  const cwd = join(workRoot, plan.root);
  let result = await runAsync(plan.command[0], plan.command.slice(1), { cwd, env, signal });
  let retried = false;
  let command = plan.command;
  // Without a lockfile, a peer-dependency conflict (ERESOLVE) is retried once with --legacy-peer-deps; reported.
  if (result.code !== 0 && plan.lockfile === null && /ERESOLVE/.test(result.stderr)) {
    retried = true;
    command = [...plan.command, '--legacy-peer-deps'];
    result = await runAsync(command[0], command.slice(1), { cwd, env, signal });
  }
  return { ...plan, command, code: result.code, message: tail(result.stderr + '\n' + result.stdout.toString('utf8')), retried, durationMs: Date.now() - started };
}

export interface PackageRef {
  id: string;
  version: string;
  direct: boolean;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Direct dependencies of a package.json with their installed versions, plus transitive ones the lockfile lists. */
export function listPackages(workRoot: string, installRoot: string, packageJson: string | null): PackageRef[] {
  const rootDir = join(workRoot, installRoot);
  const manifest = readJson(join(workRoot, packageJson ?? join(installRoot, 'package.json'))) ?? {};
  const direct = new Set<string>(
    ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(manifest[k] ?? {})),
  );
  const found = new Map<string, PackageRef>();
  const add = (id: string, version: string | undefined) => {
    if (!version) return;
    const key = `${id}@${version}`;
    if (!found.has(key)) found.set(key, { id, version, direct: direct.has(id) });
  };
  const lock = readJson(join(rootDir, 'node_modules', '.package-lock.json')) ?? readJson(join(rootDir, 'package-lock.json'));
  if (lock?.packages) {
    for (const [key, value] of Object.entries<any>(lock.packages)) {
      const i = key.lastIndexOf('node_modules/');
      if (i < 0 || value?.link) continue;
      add(value?.name ?? key.slice(i + 'node_modules/'.length), value?.version);
    }
  }
  const pnpmDir = join(rootDir, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      const m = /^(@[^+]+\+[^@]+|[^@][^@]*)@([^_]+)/.exec(entry);
      if (m) add(m[1].replace('+', '/'), m[2]);
    }
  }
  const yarnLock = join(rootDir, 'yarn.lock');
  if (existsSync(yarnLock) && found.size === 0) {
    let names: string[] = [];
    for (const line of readFileSync(yarnLock, 'utf8').split('\n')) {
      if (/^\S/.test(line) && line.endsWith(':')) {
        names = line.slice(0, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).map((s) => s.slice(0, s.lastIndexOf('@') > 0 ? s.lastIndexOf('@') : s.length));
      } else {
        const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
        if (v) for (const n of new Set(names)) add(n.replace(/@npm:.*$/, ''), v[1]);
      }
    }
  }
  for (const id of direct) {
    if ([...found.values()].some((p) => p.id === id)) continue;
    const pkg = readJson(join(rootDir, 'node_modules', id, 'package.json'));
    if (pkg?.version) add(id, pkg.version);
  }
  return [...found.values()].sort((a, b) => compareOrdinal(a.id, b.id) || compareOrdinal(a.version, b.version));
}
