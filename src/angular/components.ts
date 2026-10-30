// @Component, @Directive, @Pipe, @NgModule, @Injectable and dependency injection (PLAN 3.3).
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import type { AnalysisState } from './state.ts';
import { angularDecorators, arrayItems, booleanValue, classOf, frameworkRef, isAngular, ivyMetadata, literalTypeText, prop, propNode, stringValue, unwrap } from './common.ts';
import { compareOrdinal } from '../util/canonical.ts';

export interface DirectiveMeta {
  entity: string;
  kind: 'component' | 'directive' | 'pipe' | 'ngModule' | 'injectable';
  selector: string | null;
  pipeName: string | null;
  standalone: boolean;
  node: T.ClassDeclaration;
  source: boolean;
  decorator: T.Decorator | null;
  arg: T.ObjectLiteralExpression | null;
  imports: T.ClassDeclaration[];
  declarations: T.ClassDeclaration[];
  exports: T.ClassDeclaration[];
}

/** Per-context metadata index (source decorators and package Ivy declarations). */
export class AngularIndex {
  private readonly cache = new Map<T.ClassDeclaration, DirectiveMeta | null>();
  private readonly exportedCache = new Map<T.ClassDeclaration, DirectiveMeta[]>();
  readonly declaringModules = new Map<T.ClassDeclaration, DirectiveMeta[]>();

  readonly ex: Extractor;
  readonly ngMajor: number;

  constructor(ex: Extractor, ngMajor: number) {
    this.ex = ex;
    this.ngMajor = ngMajor;
  }

  /** Indexes every decorated class in the program's own files (so components know their declaring NgModule). */
  indexProgram(): void {
    const ts = this.ex.ts;
    const files = this.ex.program ? this.ex.program.getSourceFiles().filter((sf) => this.ex.rel(sf.fileName)) : [...this.ex.files.values()];
    for (const sf of [...files].sort((a, b) => compareOrdinal(a.fileName, b.fileName))) {
      for (const s of sf.statements) {
        if (!ts.isClassDeclaration(s)) continue;
        const meta = this.meta(s);
        if (meta?.kind === 'ngModule') {
          for (const d of meta.declarations) {
            const list = this.declaringModules.get(d) ?? [];
            list.push(meta);
            this.declaringModules.set(d, list);
          }
        }
      }
    }
  }

  meta(cls: T.ClassDeclaration): DirectiveMeta | null {
    if (this.cache.has(cls)) return this.cache.get(cls)!;
    this.cache.set(cls, null); // cycle guard
    const result = this.ex.rel(cls.getSourceFile().fileName) ? this.sourceMeta(cls) : this.packageMeta(cls);
    this.cache.set(cls, result);
    return result;
  }

  private classes(e: T.Expression | undefined): T.ClassDeclaration[] {
    const ts = this.ex.ts;
    const out: T.ClassDeclaration[] = [];
    for (const item of arrayItems(this.ex, e)) {
      let target: T.Expression = unwrap(this.ex, item);
      // X.forRoot(...), X.forChild(...): the module class X.
      if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) target = target.expression.expression;
      const cls = classOf(this.ex, target);
      if (cls) out.push(cls);
    }
    return out;
  }

  private sourceMeta(cls: T.ClassDeclaration): DirectiveMeta | null {
    const decorators = angularDecorators(this.ex, cls);
    const d = decorators.find((x) => ['Component', 'Directive', 'Pipe', 'NgModule', 'Injectable'].includes(x.name));
    if (!d) return null;
    const entity = this.ex.ensureEntity(cls);
    if (!entity) return null;
    const kinds: Record<string, DirectiveMeta['kind']> = { Component: 'component', Directive: 'directive', Pipe: 'pipe', NgModule: 'ngModule', Injectable: 'injectable' };
    const kind = kinds[d.name];
    const explicit = booleanValue(this.ex, prop(this.ex, d.arg, 'standalone'));
    return {
      entity,
      kind,
      selector: stringValue(this.ex, prop(this.ex, d.arg, 'selector')),
      pipeName: kind === 'pipe' ? stringValue(this.ex, prop(this.ex, d.arg, 'name')) : null,
      standalone: kind === 'ngModule' || kind === 'injectable' ? false : explicit ?? this.ngMajor >= 19,
      node: cls,
      source: true,
      decorator: d.node,
      arg: d.arg,
      imports: this.classes(prop(this.ex, d.arg, 'imports')),
      declarations: kind === 'ngModule' ? this.classes(prop(this.ex, d.arg, 'declarations')) : [],
      exports: kind === 'ngModule' ? this.classes(prop(this.ex, d.arg, 'exports')) : [],
    };
  }

  private packageMeta(cls: T.ClassDeclaration): DirectiveMeta | null {
    const ivy = ivyMetadata(this.ex, cls);
    if (!ivy) return null;
    const entity = this.ex.ensureEntity(cls);
    if (!entity) return null;
    const ts = this.ex.ts;
    const tuple = (t: T.TypeNode | undefined): T.ClassDeclaration[] => {
      if (!t || !ts.isTupleTypeNode(t)) return [];
      const out: T.ClassDeclaration[] = [];
      for (const el of t.elements) {
        const q = ts.isNamedTupleMember(el) ? el.type : el;
        if (!ts.isTypeQueryNode(q)) continue;
        const name = ts.isQualifiedName(q.exprName) ? q.exprName.right : q.exprName;
        const symbol = this.ex.resolveAlias(this.ex.symbolAt(name));
        const decl = symbol?.declarations?.find((x) => ts.isClassDeclaration(x)) as T.ClassDeclaration | undefined;
        if (decl) out.push(decl);
      }
      return out;
    };
    const standaloneArg = (i: number) => {
      const t = ivy.args[i];
      return !!t && ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.TrueKeyword;
    };
    return {
      entity,
      kind: ivy.kind as DirectiveMeta['kind'],
      selector: ivy.kind === 'component' || ivy.kind === 'directive' ? literalTypeText(this.ex, ivy.args[1]) : null,
      pipeName: ivy.kind === 'pipe' ? literalTypeText(this.ex, ivy.args[1]) : null,
      standalone: ivy.kind === 'pipe' ? standaloneArg(2) : standaloneArg(7),
      node: cls,
      source: false,
      decorator: null,
      arg: null,
      imports: ivy.kind === 'ngModule' ? tuple(ivy.args[2]) : [],
      declarations: ivy.kind === 'ngModule' ? tuple(ivy.args[1]) : [],
      exports: ivy.kind === 'ngModule' ? tuple(ivy.args[3]) : [],
    };
  }

  /** Directives, components and pipes a module exports, transitively through re-exported modules. */
  exported(module: T.ClassDeclaration, depth = 0): DirectiveMeta[] {
    if (this.exportedCache.has(module)) return this.exportedCache.get(module)!;
    this.exportedCache.set(module, []);
    const out: DirectiveMeta[] = [];
    const meta = this.meta(module);
    if (meta && depth < 12) {
      for (const e of meta.exports) {
        const m = this.meta(e);
        if (!m) continue;
        if (m.kind === 'ngModule') out.push(...this.exported(e, depth + 1));
        else if (m.kind !== 'injectable') out.push(m);
      }
    }
    this.exportedCache.set(module, out);
    return out;
  }

  /** What a component's template can use: its standalone imports, or its declaring NgModule's compilation scope. */
  templateScope(component: DirectiveMeta): { scope: DirectiveMeta[]; known: boolean } {
    const out: DirectiveMeta[] = [];
    const fromImports = (imports: T.ClassDeclaration[]) => {
      for (const i of imports) {
        const m = this.meta(i);
        if (!m) continue;
        if (m.kind === 'ngModule') out.push(...this.exported(i));
        else if (m.kind !== 'injectable') out.push(m);
      }
    };
    if (component.standalone) {
      fromImports(component.imports);
      return { scope: out, known: true };
    }
    const modules = this.declaringModules.get(component.node) ?? [];
    for (const module of modules) {
      for (const d of module.declarations) {
        const m = this.meta(d);
        if (m && m.kind !== 'ngModule' && m.kind !== 'injectable') out.push(m);
      }
      fromImports(module.imports);
    }
    return { scope: out, known: modules.length > 0 };
  }
}

/** ui.component, ui.directive, ui.pipe and ui.module observations for the context's own files. */
export function observeDeclarations(ex: Extractor, index: AngularIndex): void {
  const ts = ex.ts;
  for (const [rel, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    for (const s of sf.statements) {
      if (!ts.isClassDeclaration(s)) continue;
      const meta = index.meta(s);
      if (!meta || !meta.decorator) continue;
      // site: the class name (contract v1.2); the decorator stays as context evidence.
      const site = s.name ? ex.evidence(s.name) : null;
      const ev = ex.evidence(meta.decorator);
      const ids = (list: T.ClassDeclaration[]) => [...new Set(list.map((c) => ex.ensureEntity(c)).filter((x): x is string => !!x))].sort(compareOrdinal);
      if (meta.kind === 'component') {
        const templateUrl = stringValue(ex, prop(ex, meta.arg, 'templateUrl'));
        const inline = prop(ex, meta.arg, 'template');
        const templatePath = templateUrl ? resolveRelative(rel, templateUrl) : null;
        const styleUrls = arrayItems(ex, prop(ex, meta.arg, 'styleUrls')).map((e) => stringValue(ex, e)).filter((x): x is string => !!x);
        const styleUrl = stringValue(ex, prop(ex, meta.arg, 'styleUrl'));
        ex.observe('ui.component', {
          component: meta.entity,
          selector: meta.selector,
          template: templatePath ?? (inline ? rel : null),
          ext: {
            angular: {
              standalone: meta.standalone,
              inlineTemplate: !!inline,
              imports: ids(meta.imports),
              styleUrls: [...styleUrls.map((u) => resolveRelative(rel, u)), ...(styleUrl ? [resolveRelative(rel, styleUrl)] : [])].sort(compareOrdinal),
            },
          },
        }, [site, ev]);
      } else if (meta.kind === 'directive') {
        ex.observe('ui.directive', { directive: meta.entity, selector: meta.selector, ext: { angular: { standalone: meta.standalone } } }, [site, ev]);
      } else if (meta.kind === 'pipe') {
        ex.observe('ui.pipe', { pipe: meta.entity, name: meta.pipeName, ext: { angular: { standalone: meta.standalone } } }, [site, ev]);
      } else if (meta.kind === 'ngModule') {
        ex.observe('ui.module', {
          module: meta.entity,
          declarations: ids(meta.declarations),
          imports: ids(meta.imports),
          exports: ids(meta.exports),
          bootstrap: ids(classesOf(ex, prop(ex, meta.arg, 'bootstrap'))),
        }, [site, ev]);
      }
    }
  }
}

function classesOf(ex: Extractor, e: T.Expression | undefined): T.ClassDeclaration[] {
  return arrayItems(ex, e).map((x) => classOf(ex, x)).filter((x): x is T.ClassDeclaration => !!x);
}

export function resolveRelative(fromFile: string, url: string): string {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '.';
  const parts = (dir === '.' ? [] : dir.split('/')).concat(url.replace(/^\.\//, '').split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

// ---------- dependency injection ----------

/** di.consumes (constructor parameters, inject()) and di.registers (providedIn, providers arrays, bootstrap). */
export function observeDependencyInjection(ex: Extractor, index: AngularIndex, state: AnalysisState): void {
  const ts = ex.ts;
  if (!ex.checker) return;
  for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    const visit = (node: T.Node): void => {
      if (ts.isClassDeclaration(node)) classInjection(ex, index, state, node);
      if (ts.isCallExpression(node)) {
        const ref = frameworkRef(ex, node.expression);
        if (isAngular(ref, 'inject') && node.arguments.length > 0) {
          const service = ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, node.arguments[0])));
          const consumer = classContainer(ex, node) ?? ex.containerOf(node);
          if (service && consumer) {
            ex.observe('di.consumes', { service, consumer, via: 'inject', key: null }, [ex.evidence(node)]);
          }
        } else if (isAngular(ref, 'bootstrapApplication') && node.arguments.length > 1) {
          const config = unwrap(ex, node.arguments[1]);
          const obj = ts.isObjectLiteralExpression(config) ? config : objectInitializer(ex, config);
          const owner = ex.entityOfSymbol(ex.symbolAt(node.arguments[0])) ?? ex.containerOf(node)!;
          registerProviders(ex, state, prop(ex, obj, 'providers'), 'environment', owner);
        } else if (isAngular(ref, 'provideHttpClient')) {
          for (const arg of node.arguments) interceptorFeature(ex, state, arg);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  // ApplicationConfig objects exported for bootstrapApplication (app.config.ts): registered when typed ApplicationConfig.
  for (const [, sf] of ex.files) {
    for (const s of sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (!d.type || !d.initializer || !ts.isTypeReferenceNode(d.type)) continue;
        const ref = frameworkRef(ex, d.type.typeName as T.Node);
        if (!isAngular(ref, 'ApplicationConfig')) continue;
        const obj = unwrap(ex, d.initializer);
        if (!ts.isObjectLiteralExpression(obj)) continue;
        const owner = ex.ensureEntity(d) ?? ex.ensureModuleEntity(sf)!;
        registerProviders(ex, state, prop(ex, obj, 'providers'), 'environment', owner);
      }
    }
  }
}

function objectInitializer(ex: Extractor, e: T.Expression): T.ObjectLiteralExpression | null {
  const ts = ex.ts;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return null;
  const decl = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(e) ? e.name : e))?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    // The ApplicationConfig variable registers its providers itself; avoid a second registration here.
    if (decl.type && ts.isTypeReferenceNode(decl.type) && isAngular(frameworkRef(ex, decl.type.typeName as T.Node), 'ApplicationConfig')) return null;
    const init = unwrap(ex, decl.initializer);
    return ts.isObjectLiteralExpression(init) ? init : null;
  }
  return null;
}

function classContainer(ex: Extractor, node: T.Node): string | null {
  for (let p: T.Node | undefined = node.parent; p; p = p.parent) {
    if (ex.ts.isClassDeclaration(p) && ex.isEntityDeclaration(p)) return ex.ensureEntity(p);
  }
  return null;
}

function tokenNode(ex: Extractor, e: T.Expression): T.Node {
  const u = unwrap(ex, e);
  return ex.ts.isPropertyAccessExpression(u) ? u.name : u;
}

function classInjection(ex: Extractor, index: AngularIndex, state: AnalysisState, cls: T.ClassDeclaration): void {
  const ts = ex.ts;
  const meta = index.meta(cls);
  if (!meta || !meta.source || !ex.files.has(ex.rel(cls.getSourceFile().fileName)!)) return;
  // Consumers: constructor parameters.
  const ctor = cls.members.find((m): m is T.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
  for (const p of ctor?.parameters ?? []) {
    let tokenExpr: T.Node | undefined;
    const flags: string[] = [];
    for (const d of ts.canHaveDecorators(p) ? ts.getDecorators(p) ?? [] : []) {
      const call = ts.isCallExpression(d.expression) ? d.expression : null;
      const ref = frameworkRef(ex, call ? call.expression : d.expression);
      if (isAngular(ref, 'Inject') && call?.arguments[0]) tokenExpr = tokenNode(ex, call.arguments[0]);
      else if (isAngular(ref, 'Optional', 'Self', 'SkipSelf', 'Host')) flags.push(ref!.name.toLowerCase());
    }
    if (!tokenExpr && p.type && ts.isTypeReferenceNode(p.type)) tokenExpr = ts.isQualifiedName(p.type.typeName) ? p.type.typeName.right : p.type.typeName;
    if (!tokenExpr) continue;
    const service = ex.entityOfSymbol(ex.symbolAt(tokenExpr));
    if (!service) continue;
    const fields: Record<string, unknown> = { service, consumer: meta.entity, via: 'constructor', key: null };
    if (flags.length > 0) fields.ext = { angular: { flags: flags.sort(compareOrdinal) } };
    ex.observe('di.consumes', fields, [ex.evidence(p)]);
  }
  // Registrations.
  if (meta.kind === 'injectable') {
    const d = angularDecorators(ex, cls).find((x) => x.name === 'Injectable');
    const providedIn = prop(ex, d?.arg ?? null, 'providedIn');
    if (providedIn) {
      const scope = stringValue(ex, providedIn);
      const moduleScope = scope === null ? ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, providedIn))) : null;
      ex.observe('di.registers', {
        service: meta.entity,
        implementation: meta.entity,
        factory: null,
        existing: null,
        value: false,
        lifetime: scope ?? (moduleScope ? 'module' : 'unknown'),
        registrationPath: moduleScope ?? scope ?? 'unknown',
        key: null,
        conditional: false,
        multi: false,
      }, [ex.evidence(propNode(ex, d!.arg, 'providedIn')!)]);
    }
  }
  if (meta.kind === 'component' || meta.kind === 'directive') {
    registerProviders(ex, state, prop(ex, meta.arg, 'providers'), 'component', meta.entity);
    registerProviders(ex, state, prop(ex, meta.arg, 'viewProviders'), 'component', meta.entity);
  }
  if (meta.kind === 'ngModule') {
    registerProviders(ex, state, prop(ex, meta.arg, 'providers'), 'module', meta.entity);
    // ModuleWithProviders returned by source X.forRoot() calls in imports.
    for (const item of arrayItems(ex, prop(ex, meta.arg, 'imports'))) {
      const u = unwrap(ex, item);
      if (!ts.isCallExpression(u)) continue;
      const target = ex.resolveAlias(ex.symbolAt(ex.calleeName(u)))?.valueDeclaration;
      if (!target || !ex.rel(target.getSourceFile().fileName) || !(ts.isMethodDeclaration(target) || ts.isFunctionDeclaration(target)) || !target.body) continue;
      for (const r of returnedObjects(ex, target.body)) registerProviders(ex, state, prop(ex, r, 'providers'), 'module', meta.entity);
    }
  }
}

function returnedObjects(ex: Extractor, body: T.Block): T.ObjectLiteralExpression[] {
  const ts = ex.ts;
  const out: T.ObjectLiteralExpression[] = [];
  const visit = (n: T.Node): void => {
    if (ts.isReturnStatement(n) && n.expression) {
      const u = unwrap(ex, n.expression);
      if (ts.isObjectLiteralExpression(u)) out.push(u);
    }
    if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** Registers every provider of a providers expression into a scope (`component`, `module`, `environment`, `route`). */
export function registerProviders(ex: Extractor, state: AnalysisState, providers: T.Expression | undefined, lifetime: string, owner: string, depth = 0): void {
  const ts = ex.ts;
  if (!providers || depth > 3) return;
  for (const item of arrayItems(ex, providers)) {
    const u = unwrap(ex, item);
    const ev = ex.evidence(u);
    const base = { factory: null as string | null, existing: null as string | null, value: false, lifetime, registrationPath: owner, key: null, conditional: false, multi: false };
    if (ts.isIdentifier(u) || ts.isPropertyAccessExpression(u)) {
      const cls = classOf(ex, u);
      const service = ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, u)));
      if (cls && service) ex.observe('di.registers', { ...base, service, implementation: service }, [ev]);
      continue;
    }
    if (ts.isObjectLiteralExpression(u)) {
      const provide = prop(ex, u, 'provide');
      if (!provide) continue;
      const service = ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, provide)));
      if (!service) continue;
      const entityOf = (name: string) => {
        const e = prop(ex, u, name);
        if (!e) return null;
        const inner = unwrap(ex, e);
        if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return 'inline';
        return ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, inner)));
      };
      const implementation = entityOf('useClass');
      const fields = {
        ...base,
        service,
        implementation,
        factory: entityOf('useFactory'),
        existing: entityOf('useExisting'),
        value: prop(ex, u, 'useValue') !== undefined,
        multi: booleanValue(ex, prop(ex, u, 'multi')) === true,
      };
      ex.observe('di.registers', fields, [ev]);
      const ref = frameworkRef(ex, tokenNode(ex, provide));
      if (isAngular(ref, 'HTTP_INTERCEPTORS') && implementation && implementation !== 'inline') markInterceptor(state, implementation);
      continue;
    }
    if (ts.isCallExpression(u)) {
      const ref = frameworkRef(ex, u.expression);
      if (isAngular(ref, 'provideHttpClient')) {
        for (const arg of u.arguments) interceptorFeature(ex, state, arg);
        continue;
      }
      // A source function that returns providers (for example provideFeature()): follow its returned arrays.
      const target = ex.resolveAlias(ex.symbolAt(ex.calleeName(u)))?.valueDeclaration;
      if (target && ex.rel(target.getSourceFile().fileName) && (ts.isFunctionDeclaration(target) || ts.isMethodDeclaration(target)) && target.body) {
        const visit = (n: T.Node): void => {
          if (ts.isReturnStatement(n) && n.expression) registerProviders(ex, state, n.expression, lifetime, owner, depth + 1);
          if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
        };
        ts.forEachChild(target.body, visit);
      }
    }
  }
}

function interceptorFeature(ex: Extractor, state: AnalysisState, arg: T.Expression): void {
  const ts = ex.ts;
  const u = unwrap(ex, arg);
  if (!ts.isCallExpression(u) || !isAngular(frameworkRef(ex, u.expression), 'withInterceptors')) return;
  for (const item of arrayItems(ex, u.arguments[0])) {
    const id = ex.entityOfSymbol(ex.symbolAt(tokenNode(ex, item)));
    if (id) markInterceptor(state, id);
  }
}

function markInterceptor(state: AnalysisState, entity: string): void {
  state.registeredInterceptors.add(entity);
}
