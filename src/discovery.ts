// Discovery (PLAN 3.1): angular.json, Nx project.json and npm/pnpm/yarn workspaces. Every Angular application or
// library is a project; its tsconfig decides the program.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compareOrdinal } from './util/canonical.ts';

export interface FileReplacement {
  configuration: string;
  replace: string;
  with: string;
}

export interface ProjectInfo {
  name: string;
  /** Repository-relative directory, '.' for the repository root. */
  path: string;
  kind: 'angular' | 'nx' | 'workspace' | 'package';
  projectType: 'application' | 'library' | 'unknown';
  workspace: string;
  installRoot: string;
  tsConfig: string | null;
  sourceRoot: string | null;
  fileReplacements: FileReplacement[];
  proxyConfigs: { configuration: string; file: string }[];
  packageJson: string | null;
}

export interface DiscoveryProblem {
  code: string;
  scope: string;
  message: string;
}

export interface Discovery {
  projects: ProjectInfo[];
  problems: DiscoveryProblem[];
}

export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

export function norm(path: string): string {
  const n = posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return n === '' || n === '.' ? '.' : n;
}

export function joinRepo(dir: string, rel: string): string {
  return norm(dir === '.' ? rel : posix.join(dir, rel));
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

/** Reads JSON with comments and trailing commas (tsconfig, angular.json style). */
export function readJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

function inNodeModules(path: string): boolean {
  return path.split('/').includes('node_modules');
}

export function discover(root: string, paths: string[]): Discovery {
  const files = new Set(paths.filter((p) => !inNodeModules(p)));
  const problems: DiscoveryProblem[] = [];
  const projects = new Map<string, ProjectInfo>();
  const read = (path: string): unknown | undefined => {
    try {
      return readJsonc(readFileSync(join(root, path), 'utf8'));
    } catch (e) {
      problems.push({ code: 'config-unreadable', scope: path, message: `'${path}' could not be parsed: ${(e as Error).message}` });
      return undefined;
    }
  };
  const has = (p: string) => files.has(p);
  // Workspace roots (npm and yarn `workspaces`, pnpm-workspace.yaml) with the patterns of their members.
  const workspaceRoots = new Map<string, { file: string; patterns: string[]; regexes: RegExp[] }>();
  for (const file of [...files].filter((p) => p === 'package.json' || p.endsWith('/package.json') || p === 'pnpm-workspace.yaml' || p.endsWith('/pnpm-workspace.yaml')).sort(compareOrdinal)) {
    const dir = parentDir(file);
    let patterns: string[] = [];
    if (file.endsWith('pnpm-workspace.yaml')) {
      try {
        const y = parseYaml(readFileSync(join(root, file), 'utf8')) as any;
        patterns = Array.isArray(y?.packages) ? y.packages.filter((p: unknown) => typeof p === 'string') : [];
      } catch (e) {
        problems.push({ code: 'config-unreadable', scope: file, message: `'${file}' could not be parsed: ${(e as Error).message}` });
      }
    } else {
      const json = read(file) as any;
      const ws = json?.workspaces;
      patterns = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    }
    patterns = patterns.filter((p) => typeof p === 'string' && !p.startsWith('!'));
    if (patterns.length === 0) continue;
    const regexes = patterns.map((pattern) => new RegExp('^' + joinRepo(dir, pattern).split('/').map((s) => (s === '**' ? '.*' : s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/') + '$'));
    const existing = workspaceRoots.get(dir);
    if (existing) {
      existing.patterns.push(...patterns);
      existing.regexes.push(...regexes);
    } else workspaceRoots.set(dir, { file, patterns, regexes });
  }
  /**
   * Where a project's dependencies are installed: the nearest package.json at or above it, unless an ancestor
   * declares that package as a workspace member (then the workspace root). A lockfile in an unrelated ancestor
   * does not apply: npm, yarn and pnpm install a nested package on its own.
   */
  const installRootOf = (dir: string): string => {
    let nearest: string | null = null;
    for (let d = dir; ; d = parentDir(d)) {
      if (has(joinRepo(d, 'package.json'))) {
        nearest = d;
        break;
      }
      if (d === '.') break;
    }
    if (nearest === null) return dir;
    for (let d = nearest; d !== '.'; ) {
      d = parentDir(d);
      if (workspaceRoots.get(d)?.regexes.some((r) => r.test(nearest!))) return d;
    }
    return nearest;
  };
  const firstExisting = (dir: string, names: string[]): string | null => {
    for (const n of names) if (has(joinRepo(dir, n))) return joinRepo(dir, n);
    return null;
  };
  const replacementsOf = (dir: string, configurations: Record<string, any> | undefined): FileReplacement[] => {
    const out: FileReplacement[] = [];
    for (const [configuration, options] of Object.entries(configurations ?? {})) {
      for (const r of (options as any)?.fileReplacements ?? []) {
        if (typeof r?.replace === 'string' && typeof r?.with === 'string') {
          out.push({ configuration, replace: joinRepo(dir, r.replace), with: joinRepo(dir, r.with) });
        }
      }
    }
    return out;
  };
  const proxiesOf = (dir: string, target: any): { configuration: string; file: string }[] => {
    const out: { configuration: string; file: string }[] = [];
    if (typeof target?.options?.proxyConfig === 'string') out.push({ configuration: 'default', file: joinRepo(dir, target.options.proxyConfig) });
    for (const [configuration, options] of Object.entries(target?.configurations ?? {})) {
      if (typeof (options as any)?.proxyConfig === 'string') out.push({ configuration, file: joinRepo(dir, (options as any).proxyConfig) });
    }
    return out;
  };

  // angular.json
  for (const file of [...files].filter((p) => p === 'angular.json' || p.endsWith('/angular.json')).sort(compareOrdinal)) {
    const workspace = parentDir(file);
    const json = read(file) as any;
    if (!json) continue;
    for (const [name, project] of Object.entries<any>(json.projects ?? {}).sort(([a], [b]) => compareOrdinal(a, b))) {
      if (typeof project === 'string') {
        problems.push({ code: 'project-reference-unsupported', scope: file, message: `Project '${name}' in '${file}' points to a separate file; not supported.` });
        continue;
      }
      const path = joinRepo(workspace, project.root ?? '');
      const architect = project.architect ?? project.targets ?? {};
      const build = architect.build ?? {};
      const tsOption = build.options?.tsConfig;
      const tsConfig =
        typeof tsOption === 'string' && has(joinRepo(workspace, tsOption))
          ? joinRepo(workspace, tsOption)
          : firstExisting(path, project.projectType === 'library' ? ['tsconfig.lib.json', 'tsconfig.json'] : ['tsconfig.app.json', 'tsconfig.json']);
      if (projects.has(path)) {
        problems.push({ code: 'project-duplicate', scope: path, message: `'${path}' is declared by several workspace files; the first (${projects.get(path)!.workspace}) is used.` });
        continue;
      }
      projects.set(path, {
        name,
        path,
        kind: 'angular',
        projectType: project.projectType === 'library' ? 'library' : project.projectType === 'application' ? 'application' : 'unknown',
        workspace,
        installRoot: installRootOf(workspace),
        tsConfig,
        sourceRoot: typeof project.sourceRoot === 'string' ? joinRepo(workspace, project.sourceRoot) : null,
        fileReplacements: replacementsOf(workspace, build.configurations),
        proxyConfigs: proxiesOf(workspace, architect.serve),
        packageJson: has(joinRepo(path, 'package.json')) ? joinRepo(path, 'package.json') : null,
      });
    }
  }

  // Nx project.json (paths in project.json are relative to the Nx workspace root, the directory of nx.json).
  for (const file of [...files].filter((p) => p === 'project.json' || p.endsWith('/project.json')).sort(compareOrdinal)) {
    const dir = parentDir(file);
    if (projects.has(dir)) continue;
    let workspace = dir;
    for (let d = dir; ; d = parentDir(d)) {
      if (has(joinRepo(d, 'nx.json'))) {
        workspace = d;
        break;
      }
      if (d === '.') break;
    }
    const json = read(file) as any;
    if (!json) continue;
    const build = json.targets?.build ?? {};
    const tsOption = build.options?.tsConfig;
    const tsConfig =
      typeof tsOption === 'string' && has(joinRepo(workspace, tsOption.replace(/^\{workspaceRoot\}\//, '').replace(/\{projectRoot\}/, dir === '.' ? '.' : dir)))
        ? joinRepo(workspace, tsOption.replace(/^\{workspaceRoot\}\//, '').replace(/\{projectRoot\}/, dir === '.' ? '.' : dir))
        : firstExisting(dir, json.projectType === 'library' ? ['tsconfig.lib.json', 'tsconfig.json'] : ['tsconfig.app.json', 'tsconfig.json']);
    projects.set(dir, {
      name: typeof json.name === 'string' ? json.name : posix.basename(dir),
      path: dir,
      kind: 'nx',
      projectType: json.projectType === 'library' ? 'library' : json.projectType === 'application' ? 'application' : 'unknown',
      workspace,
      installRoot: installRootOf(workspace),
      tsConfig,
      sourceRoot: typeof json.sourceRoot === 'string' ? joinRepo(workspace, json.sourceRoot) : null,
      fileReplacements: replacementsOf(workspace, build.configurations),
      proxyConfigs: proxiesOf(workspace, json.targets?.serve),
      packageJson: has(joinRepo(dir, 'package.json')) ? joinRepo(dir, 'package.json') : null,
    });
  }

  // npm, yarn and pnpm workspaces: packages with a tsconfig that are not already projects.
  const directories = new Set<string>();
  for (const f of files) for (let d = parentDir(f); ; d = parentDir(d)) {
    if (directories.has(d)) break;
    directories.add(d);
    if (d === '.') break;
  }
  for (const [dir, ws] of [...workspaceRoots].sort(([a], [b]) => compareOrdinal(a, b))) {
    for (const regex of ws.regexes) {
      for (const candidate of [...directories].sort(compareOrdinal)) {
        if (!regex.test(candidate) || projects.has(candidate) || !has(joinRepo(candidate, 'package.json'))) continue;
        const tsConfig = firstExisting(candidate, ['tsconfig.lib.json', 'tsconfig.app.json', 'tsconfig.json']);
        if (!tsConfig) continue;
        const pkg = read(joinRepo(candidate, 'package.json')) as any;
        projects.set(candidate, {
          name: typeof pkg?.name === 'string' ? pkg.name : posix.basename(candidate),
          path: candidate,
          kind: 'workspace',
          projectType: 'library',
          workspace: dir,
          installRoot: installRootOf(dir),
          tsConfig,
          sourceRoot: has(joinRepo(candidate, 'src')) ? joinRepo(candidate, 'src') : null,
          fileReplacements: [],
          proxyConfigs: [],
          packageJson: joinRepo(candidate, 'package.json'),
        });
      }
    }
  }

  if (projects.size === 0 && has('tsconfig.json') && has('package.json')) {
    const pkg = read('package.json') as any;
    projects.set('.', {
      name: typeof pkg?.name === 'string' ? pkg.name : 'root',
      path: '.',
      kind: 'package',
      projectType: 'unknown',
      workspace: '.',
      installRoot: installRootOf('.'),
      tsConfig: 'tsconfig.json',
      sourceRoot: has('src') ? 'src' : null,
      fileReplacements: [],
      proxyConfigs: [],
      packageJson: 'package.json',
    });
  }
  return { projects: [...projects.values()].sort((a, b) => compareOrdinal(a.path, b.path)), problems };
}

/** The project that owns a repository path: the longest project root that contains it. */
export function ownerOf(projects: ProjectInfo[], path: string): ProjectInfo | null {
  let best: ProjectInfo | null = null;
  for (const p of projects) {
    const inside = p.path === '.' || path === p.path || path.startsWith(p.path + '/');
    if (inside && (!best || p.path.length > best.path.length || best.path === '.')) best = p;
  }
  return best;
}
