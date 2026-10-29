// Compiler selection (spikes S1 and S2, decisions A3 and A4): the repository's own TypeScript (4.8 to 6.x, which expose
// the JavaScript compiler API) and @angular/compiler (14 or later) are used when installed; otherwise the engine's pinned
// versions run, and the generation reports which compiler analysed each context.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import engineTs from 'typescript';
import * as engineNg from '@angular/compiler';

export type TS = typeof engineTs;
export type NG = typeof engineNg;

export interface Selected<T> {
  module: T;
  version: string;
  source: 'repository' | 'engine';
  repositoryVersion: string | null;
  reason: string;
}

const tsCache = new Map<string, TS>();
const ngCache = new Map<string, NG>();

function resolveVersion(dir: string, name: string): { version: string; entry: string } | null {
  try {
    const req = createRequire(join(dir, '__angular_intelligence__.js'));
    const pkgPath = req.resolve(`${name}/package.json`);
    const version = String(req(pkgPath).version);
    return { version, entry: req.resolve(name) };
  } catch {
    return null;
  }
}

function majorMinor(version: string): [number, number] {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

export function engineTypeScriptVersion(): string {
  return engineTs.version;
}

export function engineAngularCompilerVersion(): string {
  return engineNg.VERSION.full;
}

export function selectTypeScript(projectDir: string): Selected<TS> {
  const found = resolveVersion(projectDir, 'typescript');
  if (!found) return { module: engineTs, version: engineTs.version, source: 'engine', repositoryVersion: null, reason: 'typescript is not installed for this project' };
  const [major, minor] = majorMinor(found.version);
  const supported = (major === 4 && minor >= 8) || major === 5 || major === 6;
  if (!supported) {
    const reason = major >= 7 ? `typescript ${found.version} has no in-process JavaScript compiler API (spike S1)` : `typescript ${found.version} is older than 4.8`;
    return { module: engineTs, version: engineTs.version, source: 'engine', repositoryVersion: found.version, reason };
  }
  let module = tsCache.get(found.entry);
  if (!module) {
    const req = createRequire(join(projectDir, '__angular_intelligence__.js'));
    module = req(found.entry) as TS;
    tsCache.set(found.entry, module);
  }
  return { module, version: module.version, source: 'repository', repositoryVersion: found.version, reason: 'repository compiler' };
}

export async function selectAngularCompiler(projectDir: string): Promise<Selected<NG>> {
  const found = resolveVersion(projectDir, '@angular/compiler');
  const fallback = (reason: string, repositoryVersion: string | null): Selected<NG> => ({
    module: engineNg,
    version: engineNg.VERSION.full,
    source: 'engine',
    repositoryVersion,
    reason,
  });
  if (!found) return fallback('@angular/compiler is not installed for this project', null);
  const [major] = majorMinor(found.version);
  if (major < 14) return fallback(`@angular/compiler ${found.version} is older than 14`, found.version);
  let module = ngCache.get(found.entry);
  if (!module) {
    try {
      module = (await import(pathToFileURL(found.entry).href)) as NG;
    } catch (e) {
      return fallback(`@angular/compiler ${found.version} could not be loaded: ${(e as Error).message.split('\n')[0]}`, found.version);
    }
    const required = ['parseTemplate', 'TmplAstElement', 'TmplAstTemplate', 'CssSelector', 'SelectorMatcher', 'PropertyRead', 'ImplicitReceiver'];
    const missing = required.filter((k) => !(k in (module as object)));
    if (missing.length > 0) return fallback(`@angular/compiler ${found.version} lacks ${missing.join(', ')}`, found.version);
    ngCache.set(found.entry, module);
  }
  return { module, version: module.VERSION.full, source: 'repository', repositoryVersion: found.version, reason: 'repository compiler' };
}
