// analyze: export, discovery, preflight, install, load, extract, adapters, links, artifacts (PLAN 3.1 to 3.5).
// Progress is NDJSON on stdout, logs on stderr. The manifest is written last, after validation.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type * as T from 'typescript';
import { parse as parseYaml } from 'yaml';
import { exportWorkingCopy, WorkingCopyError, type WorkingCopy } from './workingcopy.ts';
import { discover, ownerOf, LOCKFILES, type ProjectInfo } from './discovery.ts';
import { planInstall, install, listPackages, type InstallResult } from './install.ts';
import { selectTypeScript, selectAngularCompiler, engineTypeScriptVersion, engineAngularCompilerVersion, type TS } from './toolchain.ts';
import { Generation, ENGINE_NAME, ENGINE_VERSION, sortedRecords, type LoadMode, type Rec } from './model.ts';
import { Extractor } from './extract/core.ts';
import { EnvRegistry } from './angular/environments.ts';
import type { AnalysisState, EngineConfig } from './angular/state.ts';
import { AngularIndex, observeDeclarations, observeDependencyInjection } from './angular/components.ts';
import { observeTemplates } from './angular/templates.ts';
import { observeRoutes, observeUnreachedRoutes } from './angular/routes.ts';
import { collectHttp, collectInterceptors, collectProxies, emitHttpCalls, type PendingCall, type ProxyRule } from './angular/http.ts';
import { observeRealtime } from './angular/realtime.ts';
import { observeNgrx, emitEffects, type PendingEffect } from './angular/ngrx.ts';
import { buildLinks, possibleRuntimeTargets } from './links.ts';
import { checkIntegrity, type RecordSet } from './artifacts/integrity.ts';
import { writeRecords, fileList, SCHEMA_VERSION } from './artifacts/generation.ts';
import { writeIndex, sqliteInfo } from './artifacts/sqlite.ts';
import { writePacks } from './artifacts/packs.ts';
import { recordId, sha256Hex, compareOrdinal, canonical } from './util/canonical.ts';

export const EXIT = { complete: 0, partial: 10, preflight: 20, nothing: 30, cancelled: 40, integrity: 50, internal: 1, usage: 2 } as const;

export interface AnalyzeOptions {
  src: string;
  out: string;
  work: string;
  cache: string;
  config: string | null;
  project: string | null;
  includeWorkingTree: boolean;
  offline: boolean;
  noInstall: boolean;
  signal: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
  log: (message: string) => void;
}

class Cancelled extends Error {}

export async function analyze(o: AnalyzeOptions): Promise<number> {
  const started = Date.now();
  const timings: Record<string, number> = {};
  let stageStart = 0;
  let current = '';
  const stage = (name: string) => {
    if (current) {
      timings[current] = Date.now() - stageStart;
      o.emit({ event: 'stage.end', stage: current, ms: timings[current] });
    }
    if (o.signal.aborted) throw new Cancelled();
    current = name;
    stageStart = Date.now();
    if (name) o.emit({ event: 'stage.start', stage: name });
  };
  o.emit({ event: 'run.start', engine: ENGINE_NAME, version: ENGINE_VERSION });
  const finish = (status: string, exitCode: number) => {
    o.emit({ event: 'run.end', status, exitCode });
    return exitCode;
  };
  if (existsSync(o.out) && readdirSync(o.out).length > 0) {
    o.log(`output directory '${o.out}' is not empty`);
    return finish('failed', EXIT.internal);
  }
  try {
    // ---------- export ----------
    stage('export');
    const repoRoot = join(o.work, 'repo');
    rmSync(o.work, { recursive: true, force: true });
    let wc: WorkingCopy;
    try {
      wc = exportWorkingCopy(o.src, repoRoot, o.includeWorkingTree);
    } catch (e) {
      if (e instanceof WorkingCopyError) {
        o.emit({ event: 'diagnostic', severity: 'error', code: 'working-copy-failed', message: e.message });
        stage('');
        return finish('failed', EXIT.nothing);
      }
      throw e;
    }
    const gen = new Generation(repoRoot, wc.blobs);
    for (const d of wc.diagnostics) gen.diagnostic(d.severity, d.code, d.scope, d.state, d.message);
    let configText: string | null = null;
    let config: EngineConfig = {};
    if (o.config) {
      configText = readFileSync(o.config, 'utf8');
      config = (parseYaml(configText) ?? {}) as EngineConfig;
    }

    // ---------- discovery ----------
    stage('discovery');
    const paths = [...wc.blobs.keys()].sort(compareOrdinal);
    const discovery = discover(repoRoot, paths);
    for (const p of discovery.problems) gen.diagnostic('warning', p.code, p.scope, 'partial', p.message);
    let projects = discovery.projects;
    if (o.project) {
      projects = projects.filter((p) => p.name === o.project || p.path === o.project);
      if (projects.length === 0) gen.diagnostic('error', 'project-not-found', o.project, 'failed', `No project named or located at '${o.project}'.`);
    }
    if (projects.length === 0) {
      o.emit({ event: 'diagnostic', severity: 'error', code: 'no-projects', message: 'No Angular, Nx, workspace or TypeScript project was found.' });
      stage('');
      return finish('failed', EXIT.nothing);
    }

    // ---------- preflight ----------
    stage('preflight');
    const roots = [...new Set(projects.map((p) => p.installRoot))].sort(compareOrdinal);
    const plans = roots.map((r) => planInstall(repoRoot, r, o.offline));
    for (const plan of plans) {
      if (!plan.lockfile) {
        gen.diagnostic('warning', 'lockfile-missing', plan.root, 'unknown', `No lockfile (${LOCKFILES.join(', ')}) in '${plan.root}': dependency versions are resolved at analysis time, so results can change between runs on the same commit.`);
      }
    }

    // ---------- install ----------
    stage('install');
    const installs = new Map<string, InstallResult | null>();
    for (const plan of plans) {
      if (o.noInstall) {
        installs.set(plan.root, null);
        continue;
      }
      if (!existsSync(join(repoRoot, plan.root, 'package.json'))) {
        installs.set(plan.root, null);
        gen.diagnostic('warning', 'package-json-missing', plan.root, 'partial', `'${plan.root}' has no package.json; nothing to install.`);
        continue;
      }
      o.log(`install ${plan.root}: ${plan.command.join(' ')}`);
      const result = await install(repoRoot, plan, o.cache, o.signal);
      if (o.signal.aborted) throw new Cancelled();
      installs.set(plan.root, result);
      if (result.retried) gen.diagnostic('warning', 'install-retried', plan.root, 'unknown', `Install without a lockfile failed on a peer-dependency conflict (ERESOLVE) and was retried once with --legacy-peer-deps (exit code ${result.code}).`);
      if (result.code !== 0) gen.diagnostic('error', 'install-failed', plan.root, 'failed', `${plan.command.slice(0, 2).join(' ')} failed with exit code ${result.code}: ${result.message}`);
    }
    const installed = (p: ProjectInfo) => installs.get(p.installRoot)?.code === 0;

    // ---------- load ----------
    stage('load');
    const extractors: Extractor[] = [];
    const ngMajors = new Map<Extractor, { major: number; version: string; source: string; reason: string }>();
    for (const project of projects) {
      const projectId = recordId('prj', { path: project.path });
      const packages = installed(project) ? listPackages(repoRoot, project.installRoot, project.packageJson) : [];
      let npm: { name: string | null; version: string | null } = { name: null, version: null };
      if (project.packageJson) {
        try {
          const pkg = JSON.parse(readFileSync(join(repoRoot, project.packageJson), 'utf8'));
          npm = { name: typeof pkg.name === 'string' ? pkg.name : null, version: typeof pkg.version === 'string' ? pkg.version : null };
        } catch {
          npm = { name: null, version: null };
        }
      }
      gen.projects.set(projectId, {
        id: projectId,
        recordType: 'project',
        path: project.path,
        solutions: [],
        assemblyName: null,
        targetFrameworks: [],
        resolvedSdk: null,
        projectReferences: [],
        packages,
        language: 'typescript',
        npmName: project.projectType === 'library' ? npm.name : null,
        npmVersion: project.projectType === 'library' ? npm.version : null,
        ext: { angular: { name: project.name, kind: project.kind, projectType: project.projectType, workspace: project.workspace, installRoot: project.installRoot, tsConfig: project.tsConfig, sourceRoot: project.sourceRoot } },
      });
      const projectDir = join(repoRoot, project.path);
      const tsSel = installed(project) ? selectTypeScript(projectDir) : selectTypeScript('/nonexistent');
      const ngSel = installed(project) ? await selectAngularCompiler(projectDir) : await selectAngularCompiler('/nonexistent');
      const ts = tsSel.module;
      let loadMode: LoadMode = 'failed';
      let reason = '';
      let program: T.Program | null = null;
      let compilationErrors = 0;
      let fileNames: string[] = [];
      let options: T.CompilerOptions = {};
      let references: readonly T.ProjectReference[] | undefined;
      if (!project.tsConfig) {
        reason = 'no tsconfig for this project';
      } else {
        const parsed = parseConfig(ts, join(repoRoot, project.tsConfig), tsSel.source === 'engine');
        fileNames = parsed.fileNames;
        options = parsed.options;
        references = parsed.references;
        if (parsed.errors.length > 0) {
          gen.diagnostic('warning', 'tsconfig-errors', project.tsConfig, 'partial', `${parsed.errors.length} tsconfig diagnostic(s): ${parsed.errors[0]}`);
        }
        if (fileNames.length === 0) {
          reason = `tsconfig '${project.tsConfig}' selects no files`;
        } else if (!installed(project)) {
          loadMode = 'syntax';
          reason = o.noInstall ? 'install skipped (--no-install); parser only' : 'dependencies are not installed; parser only';
        } else {
          try {
            program = ts.createProgram({ rootNames: fileNames, options, projectReferences: references });
            loadMode = 'semantic';
            reason = `typescript ${ts.version} (${tsSel.source}) program with type checker`;
            for (const sf of program.getSourceFiles()) {
              const rel = relativeTo(repoRoot, sf.fileName);
              if (rel && wc.blobs.has(rel)) compilationErrors += program.getSemanticDiagnostics(sf).length + program.getSyntacticDiagnostics(sf).length;
            }
          } catch (e) {
            loadMode = 'syntax';
            reason = `program creation failed: ${(e as Error).message.split('\n')[0]}`;
            program = null;
          }
        }
      }
      const contextId = recordId('ctx', { project: project.path, tsConfig: project.tsConfig, configuration: 'default' });
      const ctxRecord: Rec = {
        id: contextId,
        recordType: 'analysisContext',
        project: project.path,
        projectId,
        configuration: 'default',
        loadMode,
        reason,
        ext: {
          typescript: {
            tsConfig: project.tsConfig,
            compiler: ts.version,
            compilerSource: tsSel.source,
            compilerReason: tsSel.reason,
            repositoryVersion: tsSel.repositoryVersion,
            angularCompiler: ngSel.version,
            angularCompilerSource: ngSel.source,
            angularCompilerReason: ngSel.reason,
            angularRepositoryVersion: ngSel.repositoryVersion,
          },
        },
      };
      if (loadMode === 'semantic') ctxRecord.compilationErrors = compilationErrors;
      gen.contexts.set(contextId, ctxRecord);
      if (loadMode === 'syntax') gen.diagnostic('warning', 'syntax-fallback', project.path, 'partial', `${project.name}: ${reason}.`);
      if (loadMode === 'failed') gen.diagnostic('error', 'load-failed', project.path, 'failed', `${project.name}: ${reason}.`);
      if (loadMode === 'semantic' && compilationErrors > 0) gen.diagnostic('info', 'compilation-errors', project.path, 'unknown', `${project.name}: ${compilationErrors} TypeScript diagnostic(s) in repository files with typescript ${ts.version}; symbols in erroneous code may be unresolved.`);
      if (loadMode === 'failed') continue;
      const ex = new Extractor({ gen, ts, program, project, projects, contextId, workRoot: repoRoot, method: loadMode === 'semantic' ? 'semantic' : 'syntax' });
      if (loadMode === 'syntax') {
        // Parser only: the tsconfig root files and every repository file they reach through relative imports.
        const queue = [...fileNames];
        const seen = new Set<string>();
        while (queue.length > 0) {
          const f = queue.shift()!;
          const rel = relativeTo(repoRoot, f);
          if (!rel || seen.has(rel) || !wc.blobs.has(rel) || !/\.(ts|tsx|mts|cts)$/.test(rel)) continue;
          seen.add(rel);
          const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
          ex.allFiles.push([rel, sf]);
          for (const s of sf.statements) {
            const spec = (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null;
            if (!spec || !spec.startsWith('.')) continue;
            const base = join(dirname(f), spec);
            for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
              if (wc.blobs.has(relativeTo(repoRoot, candidate) ?? '') && /\.(ts|tsx)$/.test(candidate)) queue.push(candidate);
            }
          }
        }
        ex.allFiles.sort(([a], [b]) => compareOrdinal(a, b));
      }
      ngMajors.set(ex, { major: Number(ngSel.version.split('.')[0]), version: ngSel.version, source: ngSel.source, reason: ngSel.reason });
      ex.angular = ngSel;
      extractors.push(ex);
    }
    if (extractors.length === 0) {
      stage('');
      o.emit({ event: 'diagnostic', severity: 'error', code: 'nothing-loaded', message: 'No project could be loaded.' });
      return finish('failed', EXIT.nothing);
    }

    // File assignment: each repository file is extracted once, by its owner's context when that program includes it.
    const candidates = new Map<string, Extractor[]>();
    for (const ex of extractors) {
      if (ex.program) {
        for (const sf of ex.program.getSourceFiles()) {
          const rel = relativeTo(repoRoot, sf.fileName);
          if (rel && wc.blobs.has(rel) && !rel.split('/').includes('node_modules')) ex.allFiles.push([rel, sf]);
        }
      }
      for (const [rel] of ex.allFiles) candidates.set(rel, [...(candidates.get(rel) ?? []), ex]);
    }
    for (const [rel, list] of [...candidates].sort(([a], [b]) => compareOrdinal(a, b))) {
      const owner = ownerOf(projects, rel);
      const chosen = list.find((e) => e.project === owner && e.method === 'semantic') ?? list.find((e) => e.method === 'semantic') ?? list.find((e) => e.project === owner) ?? list[0];
      const sf = chosen.allFiles.find(([r]) => r === rel)![1];
      chosen.files.set(rel, sf);
    }
    const appsIncludingMap = new Map<string, Set<string>>();
    for (const ex of extractors) for (const [rel] of ex.allFiles) appsIncludingMap.set(rel, (appsIncludingMap.get(rel) ?? new Set()).add(ex.project.path));
    const env = new EnvRegistry(repoRoot, projects, paths);
    const state: AnalysisState = {
      env,
      config,
      extractors,
      appsIncluding: (rel) => env.apps.filter((a) => appsIncludingMap.get(rel)?.has(a.project.path)),
      routeTablesReached: new Set(),
      interceptors: [],
      registeredInterceptors: new Set(),
    };

    // ---------- extract ----------
    stage('extract');
    for (const ex of extractors) {
      for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) ex.extractFile(sf);
    }

    // ---------- adapters ----------
    stage('adapters');
    const indexes = new Map<Extractor, AngularIndex>();
    const pendingCalls: PendingCall[] = [];
    const pendingEffects: PendingEffect[] = [];
    const proxies: ProxyRule[] = [];
    for (const ex of extractors) {
      const index = new AngularIndex(ex, ngMajors.get(ex)!.major);
      indexes.set(ex, index);
      index.indexProgram();
      observeDeclarations(ex, index);
      observeDependencyInjection(ex, index, state);
    }
    for (const ex of extractors) {
      const index = indexes.get(ex)!;
      observeRoutes(ex, index, state);
      if (ex.checker && ex.angular) observeTemplates(ex, index, ex.angular);
      collectInterceptors(ex, state);
      collectHttp(ex, state, pendingCalls);
      observeRealtime(ex, state);
      observeNgrx(ex, pendingEffects);
      if (ex.project.proxyConfigs.length > 0) proxies.push(...collectProxies(ex, ex.project));
    }
    for (const ex of extractors) observeUnreachedRoutes(ex, indexes.get(ex)!, state);
    // config.key for every environment file, by the context of the project that owns it (method `config`).
    for (const [file, envFile] of [...env.files].sort(([a], [b]) => compareOrdinal(a, b))) {
      const owner = ownerOf(projects, file);
      const ex = extractors.find((e) => e.project === owner) ?? extractors[0];
      for (const entry of [...envFile.entries.values()].sort((a, b) => compareOrdinal(a.key, b.key))) {
        ex.observe('config.key', { key: entry.key, file, secret: entry.secret, configurations: env.apps.filter((a) => a.defaultFile === file || a.configurations.some((c) => c.file === file)).flatMap((a) => (a.defaultFile === file ? ['default'] : a.configurations.filter((c) => c.file === file).map((c) => c.configuration))).sort(compareOrdinal) }, [ex.evidenceAt(file, entry.span, 'config')]);
      }
    }
    emitHttpCalls(state, pendingCalls, proxies);
    const httpByCaller = new Map<string, string[]>();
    for (const obs of gen.observations.values()) {
      if (obs.kind === 'http.call' && typeof obs.caller === 'string') httpByCaller.set(obs.caller, [...(httpByCaller.get(obs.caller) ?? []), obs.id]);
    }
    const callsFrom = new Map<string, Set<string>>();
    for (const r of gen.relations.values()) if (r.kind === 'calls_declared_target') callsFrom.set(r.from as string, (callsFrom.get(r.from as string) ?? new Set()).add(r.to as string));
    emitEffects(pendingEffects, callsFrom, httpByCaller);

    // ---------- links ----------
    stage('links');
    possibleRuntimeTargets(gen);
    buildLinks(gen);

    // ---------- artifacts ----------
    stage('artifacts');
    const set: RecordSet = {
      projects: sortedRecords(new Map([...gen.projects, ...gen.contexts])),
      entities: sortedRecords(gen.entities),
      declarations: sortedRecords(gen.declarations),
      relations: sortedRecords(gen.relations),
      evidence: sortedRecords(gen.evidence),
      observations: sortedRecords(gen.observations),
      links: sortedRecords(gen.links),
      diagnostics: sortedRecords(gen.diagnostics),
      snippets: sortedRecords(gen.snippets),
    };
    const integrity = checkIntegrity(set, wc.blobs);
    if (integrity.errors.length > 0) {
      for (const e of integrity.errors) o.log(`integrity: ${e}`);
      o.emit({ event: 'diagnostic', severity: 'error', code: 'integrity-failed', message: `${integrity.errors.length} integrity error(s); no manifest written` });
      stage('');
      return finish('failed', EXIT.integrity);
    }
    const contexts = [...gen.contexts.values()];
    const summary = {
      total: projects.length,
      semantic: contexts.filter((c) => c.loadMode === 'semantic').length,
      syntax: contexts.filter((c) => c.loadMode === 'syntax').length,
      failed: contexts.filter((c) => c.loadMode === 'failed').length,
      notAnalyzed: 0,
    };
    const degraded = set.diagnostics.some((d) => d.state === 'failed' || d.state === 'partial');
    const status = summary.semantic === 0 && summary.syntax === 0 ? 'failed' : summary.syntax > 0 || summary.failed > 0 || degraded ? 'partial' : 'complete';
    mkdirSync(o.out, { recursive: true });
    writeRecords(o.out, set);
    const sqlite = sqliteInfo();
    writeIndex(join(o.out, 'index.sqlite'), set, { schemaVersion: SCHEMA_VERSION, commit: wc.commit, engine: `${ENGINE_NAME}@${ENGINE_VERSION}`, indexSchema: '1', status, coverage: canonical(summary) });
    writePacks(o.out, set, wc.commit, status, wc.remoteUrl ?? 'repository');
    const files = fileList(o.out);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      requiredCapabilities: [],
      status,
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
      imageDigest: process.env.AI_IMAGE_DIGEST ?? 'unknown',
      toolchain: {
        name: 'node',
        version: process.version,
        typescript: engineTypeScriptVersion(),
        angularCompiler: engineAngularCompilerVersion(),
        sqlite: sqlite.version,
        contexts: contexts.map((c) => ({ context: c.id, project: c.project, ...((c.ext as any).typescript as object) })).sort((a, b) => compareOrdinal(a.context, b.context)),
      },
      repository: { remoteUrl: wc.remoteUrl },
      commit: wc.commit,
      objectFormat: wc.objectFormat,
      dirty: wc.dirty,
      configurationHash: configText === null ? null : sha256Hex(configText),
      analysisContexts: contexts.map((c) => c.id).sort(compareOrdinal),
      coverage: {
        projects: projects.map((p) => {
          const c = contexts.find((x) => x.project === p.path);
          const ex = extractors.find((e) => e.project === p);
          return { project: p.path, name: p.name, loadMode: c?.loadMode ?? 'not-analyzed', files: ex ? ex.files.size : 0, compilationErrors: c?.compilationErrors ?? null };
        }),
        summary,
      },
      installs: plans.map((p) => {
        const r = installs.get(p.root);
        return { root: p.root, manager: p.manager, lockfile: p.lockfile, command: r?.command ?? p.command, exitCode: r ? r.code : null };
      }),
      files,
    };
    writeFileSync(join(o.out, 'manifest.json'), canonical(manifest) + '\n');
    stage('');
    const run = {
      timings,
      totalMs: Date.now() - started,
      host: { platform: process.platform, arch: process.arch, node: process.version },
      counts: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v.length])),
      installs: [...installs.values()].filter((x): x is InstallResult => !!x).map((r) => ({ root: r.root, ms: r.durationMs, code: r.code })),
      notes: integrity.notes,
    };
    writeFileSync(join(o.out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    for (const d of set.diagnostics) o.emit({ event: 'diagnostic', severity: d.severity, code: d.code, scope: d.scope, state: d.state, message: d.message });
    return finish(status, status === 'complete' ? EXIT.complete : status === 'partial' ? EXIT.partial : EXIT.nothing);
  } catch (e) {
    if (e instanceof Cancelled || o.signal.aborted) {
      rmSync(join(o.out, 'manifest.json'), { force: true });
      return finish('cancelled', EXIT.cancelled);
    }
    o.log(`internal error: ${(e as Error).stack ?? e}`);
    return finish('failed', EXIT.internal);
  }
}

function relativeTo(root: string, fileName: string): string | null {
  const norm = fileName.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/') + '/';
  return norm.startsWith(r) ? norm.slice(r.length) : null;
}

/** Parses a tsconfig; a solution-style config (no files, only references) is expanded to its referenced configs. */
function parseConfig(ts: TS, file: string, engineCompiler: boolean): { fileNames: string[]; options: T.CompilerOptions; references?: readonly T.ProjectReference[]; errors: string[] } {
  const read = ts.readConfigFile(file, ts.sys.readFile);
  const errors: string[] = [];
  const message = (d: T.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, ' ');
  if (read.error) return { fileNames: [], options: {}, errors: [message(read.error)] };
  const existing: T.CompilerOptions = engineCompiler ? ({ ignoreDeprecations: '6.0' } as T.CompilerOptions) : {};
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file), existing, file);
  // "No inputs were found" (18003) is not fatal for solution-style configs.
  errors.push(...parsed.errors.filter((d) => d.code !== 18003).map(message));
  if (parsed.fileNames.length === 0 && parsed.projectReferences && parsed.projectReferences.length > 0) {
    const names = new Set<string>();
    let options: T.CompilerOptions | null = null;
    for (const ref of parsed.projectReferences) {
      const refFile = ts.resolveProjectReferencePath(ref);
      if (!existsSync(refFile)) continue;
      const sub = parseConfig(ts, refFile, engineCompiler);
      for (const n of sub.fileNames) names.add(n);
      options ??= sub.options;
      errors.push(...sub.errors);
    }
    return { fileNames: [...names].sort(compareOrdinal), options: options ?? parsed.options, errors };
  }
  return { fileNames: [...parsed.fileNames].sort(compareOrdinal), options: parsed.options, references: parsed.projectReferences, errors };
}
