// Routing (PLAN 3.3): Routes arrays from RouterModule.forRoot/forChild and provideRouter, nested children, lazy
// loadChildren and loadComponent (dynamic imports resolved to modules), guards and resolvers. Output: ui.route with
// the full path. Tables no root configuration reaches are reported with their relative path only.
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import type { AnalysisState } from './state.ts';
import { type AngularIndex } from './components.ts';
import { registerProviders } from './components.ts';
import { arrayItems, classOf, frameworkRef, isAngular, prop, propNode, stringValue, unwrap } from './common.ts';
import { compareOrdinal } from '../util/canonical.ts';

const GUARDS = ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch', 'canLoad'];

function key(ex: Extractor, node: T.Node): string {
  return `${ex.rel(node.getSourceFile().fileName) ?? node.getSourceFile().fileName}:${node.pos}`;
}

function joinPath(parent: string, path: string): string {
  const segments = [...parent.split('/'), ...path.split('/')].filter((s) => s.length > 0);
  return '/' + segments.join('/');
}

interface RouterCall {
  kind: 'root' | 'child';
  table: T.Expression;
  call: T.CallExpression;
}

function routerCalls(ex: Extractor, sf: T.SourceFile): RouterCall[] {
  const ts = ex.ts;
  const out: RouterCall[] = [];
  const visit = (n: T.Node): void => {
    if (ts.isCallExpression(n) && n.arguments.length > 0) {
      const ref = frameworkRef(ex, n.expression);
      if (isAngular(ref, 'RouterModule.forRoot', 'provideRouter')) out.push({ kind: 'root', table: n.arguments[0], call: n });
      else if (isAngular(ref, 'RouterModule.forChild', 'provideRoutes')) out.push({ kind: 'child', table: n.arguments[0], call: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Route tables of NgModules reached through loadChildren: forChild tables in the module's (transitive) source imports. */
function moduleTables(ex: Extractor, index: AngularIndex, module: T.ClassDeclaration, seen = new Set<T.ClassDeclaration>()): T.Expression[] {
  const ts = ex.ts;
  if (seen.has(module) || !ex.rel(module.getSourceFile().fileName)) return [];
  seen.add(module);
  const meta = index.meta(module);
  if (!meta || meta.kind !== 'ngModule') return [];
  const out: T.Expression[] = [];
  for (const item of arrayItems(ex, prop(ex, meta.arg, 'imports'))) {
    const u = unwrap(ex, item);
    if (ts.isCallExpression(u) && isAngular(frameworkRef(ex, u.expression), 'RouterModule.forChild') && u.arguments[0]) {
      out.push(u.arguments[0]);
      continue;
    }
    const cls = classOf(ex, ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) ? u.expression.expression : u);
    if (cls) out.push(...moduleTables(ex, index, cls, seen));
  }
  return out;
}

interface LazyTarget {
  entity: string | null;
  node: T.Node | null;
}

/** `() => import('x').then(m => m.Y)`, `() => import('x')` (default export) or a direct reference. */
function lazyTarget(ex: Extractor, e: T.Expression): LazyTarget {
  const ts = ex.ts;
  let body: T.Node = unwrap(ex, e);
  if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) {
    const b = body.body;
    if (ts.isBlock(b)) {
      const ret = b.statements.find((s): s is T.ReturnStatement => ts.isReturnStatement(s));
      if (!ret?.expression) return { entity: null, node: null };
      body = unwrap(ex, ret.expression);
    } else body = unwrap(ex, b as T.Expression);
  }
  let exportName = 'default';
  let importCall: T.CallExpression | null = null;
  if (ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression) && body.expression.name.text === 'then' && ts.isCallExpression(unwrap(ex, body.expression.expression))) {
    importCall = unwrap(ex, body.expression.expression) as T.CallExpression;
    const cb = body.arguments[0] ? unwrap(ex, body.arguments[0]) : undefined;
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      let r: T.Node = cb.body;
      if (ts.isBlock(r)) r = r.statements.find((s): s is T.ReturnStatement => ts.isReturnStatement(s))?.expression ?? r;
      r = unwrap(ex, r as T.Expression);
      // m.X or m.X.forLazy(): the exported member X.
      if (ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression)) r = unwrap(ex, r.expression.expression);
      if (ts.isPropertyAccessExpression(r)) exportName = r.name.text;
      else if (ts.isElementAccessExpression(r) && ts.isStringLiteral(r.argumentExpression)) exportName = r.argumentExpression.text;
    }
  } else if (ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword) {
    importCall = body;
  }
  if (!importCall) {
    // Eager reference: loadChildren: () => FeatureModule, or a Routes constant.
    if (ts.isIdentifier(body) || ts.isPropertyAccessExpression(body)) {
      const decl = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(body) ? body.name : body))?.declarations?.[0];
      return decl ? { entity: ex.entityOfSymbol(ex.symbolAt(ts.isPropertyAccessExpression(body) ? body.name : body)), node: decl } : { entity: null, node: null };
    }
    return { entity: null, node: null };
  }
  const specifier = importCall.arguments[0];
  if (!specifier || !ex.checker) return { entity: null, node: null };
  const moduleSymbol = ex.symbolAt(specifier);
  if (!moduleSymbol) return { entity: null, node: null };
  const exports = ex.checker.getExportsOfModule(moduleSymbol);
  const sym = exports.find((s) => s.name === exportName);
  const resolved = ex.resolveAlias(sym);
  const decl = resolved?.declarations?.[0];
  if (!decl) return { entity: null, node: null };
  return { entity: ex.entityOfSymbol(resolved), node: decl };
}

export function observeRoutes(ex: Extractor, index: AngularIndex, state: AnalysisState): void {
  if (!ex.checker) return;
  for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    for (const call of routerCalls(ex, sf)) {
      if (call.kind === 'root') visitTable(ex, index, state, call.table, '', new Set(), 0);
    }
  }
}

/** Second pass, after every context: tables no root configuration reached. */
export function observeUnreachedRoutes(ex: Extractor, index: AngularIndex, state: AnalysisState): void {
  if (!ex.checker) return;
  const ts = ex.ts;
  for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    const tables: T.Expression[] = routerCalls(ex, sf).filter((c) => c.kind === 'child').map((c) => c.table);
    for (const s of sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (d.initializer && d.type && ts.isTypeReferenceNode(d.type) && isAngular(frameworkRef(ex, d.type.typeName as T.Node), 'Routes') && ex.isEntityDeclaration(d)) tables.push(d.initializer);
      }
    }
    for (const table of tables) {
      const resolved = resolveTable(ex, table);
      if (!resolved || state.routeTablesReached.has(key(ex, resolved))) continue;
      visitTable(ex, index, state, table, null, new Set(), 0);
    }
  }
}

function resolveTable(ex: Extractor, e: T.Expression): T.Expression | null {
  const ts = ex.ts;
  let u = unwrap(ex, e);
  for (let i = 0; i < 6 && !ts.isArrayLiteralExpression(u); i++) {
    if (!ts.isIdentifier(u) && !ts.isPropertyAccessExpression(u)) return null;
    const decl = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(u) ? u.name : u))?.valueDeclaration;
    if (!decl || !(ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) || !decl.initializer) return null;
    u = unwrap(ex, decl.initializer);
  }
  return ts.isArrayLiteralExpression(u) ? u : null;
}

function guardEntity(ex: Extractor, e: T.Expression): string {
  const ts = ex.ts;
  const u = unwrap(ex, e);
  if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return 'inline';
  const target = ts.isCallExpression(u) ? ex.calleeName(u) : ts.isPropertyAccessExpression(u) ? u.name : u;
  return ex.entityOfSymbol(ex.symbolAt(target)) ?? 'unresolved';
}

/** parentPath null: the table is not reached from a root configuration; paths are relative. */
function visitTable(ex: Extractor, index: AngularIndex, state: AnalysisState, tableExpr: T.Expression, parentPath: string | null, chain: Set<string>, depth: number): void {
  const ts = ex.ts;
  const table = resolveTable(ex, tableExpr);
  if (!table || depth > 16) return;
  const k = key(ex, table);
  if (chain.has(k)) return;
  if (parentPath !== null) state.routeTablesReached.add(k);
  const nextChain = new Set(chain).add(k);
  for (const item of arrayItems(ex, table)) {
    const route = unwrap(ex, item);
    if (!ts.isObjectLiteralExpression(route)) continue;
    const path = stringValue(ex, prop(ex, route, 'path')) ?? '';
    const full = parentPath === null ? null : joinPath(parentPath, path);
    const relative = parentPath === null ? path : null;
    const entityOf = (name: string) => {
      const e = prop(ex, route, name);
      return e ? ex.entityOfSymbol(ex.symbolAt(ts.isPropertyAccessExpression(unwrap(ex, e)) ? (unwrap(ex, e) as T.PropertyAccessExpression).name : unwrap(ex, e))) ?? 'unresolved' : null;
    };
    const guards: Record<string, string[]> = {};
    for (const g of GUARDS) {
      const items = arrayItems(ex, prop(ex, route, g));
      if (items.length > 0) guards[g] = [...new Set(items.map((i) => guardEntity(ex, i)))].sort(compareOrdinal);
    }
    const resolveObj = prop(ex, route, 'resolve');
    const resolvers: Record<string, string> = {};
    if (resolveObj && ts.isObjectLiteralExpression(unwrap(ex, resolveObj))) {
      for (const p of (unwrap(ex, resolveObj) as T.ObjectLiteralExpression).properties) {
        if (ts.isPropertyAssignment(p)) resolvers[ex.memberName(p.name)] = guardEntity(ex, p.initializer);
      }
    }
    const loadChildrenExpr = prop(ex, route, 'loadChildren');
    const loadComponentExpr = prop(ex, route, 'loadComponent');
    const children = loadChildrenExpr ? lazyTarget(ex, loadChildrenExpr) : null;
    const lazyComponent = loadComponentExpr ? lazyTarget(ex, loadComponentExpr) : null;
    const fields: Record<string, unknown> = {
      path: full,
      component: entityOf('component'),
      loadComponent: lazyComponent ? lazyComponent.entity ?? 'unresolved' : null,
      loadChildren: children ? children.entity ?? 'unresolved' : null,
      redirectTo: stringValue(ex, prop(ex, route, 'redirectTo')),
      guards,
      resolvers,
      ext: {
        angular: {
          ...(relative !== null ? { relativePath: relative, reason: 'no root router configuration reaches this table' } : {}),
          pathMatch: stringValue(ex, prop(ex, route, 'pathMatch')),
          outlet: stringValue(ex, prop(ex, route, 'outlet')),
          lazy: !!(loadChildrenExpr || loadComponentExpr),
        },
      },
    };
    const anchor = propNode(ex, route, 'path') ?? route;
    ex.observe('ui.route', fields, [ex.evidence(anchor)]);
    const providers = prop(ex, route, 'providers');
    if (providers) registerProviders(ex, state, providers, 'route', ex.ensureModuleEntity(route.getSourceFile())!);
    const childPath = full ?? (relative !== null ? relative : '');
    const nextParent = parentPath === null ? null : childPath;
    const childrenExpr = prop(ex, route, 'children');
    if (childrenExpr) visitTable(ex, index, state, childrenExpr, nextParent, nextChain, depth + 1);
    if (children?.node && ex.rel(children.node.getSourceFile().fileName)) {
      const n = children.node;
      if (ts.isClassDeclaration(n)) {
        for (const t of moduleTables(ex, index, n)) visitTable(ex, index, state, t, nextParent, nextChain, depth + 1);
      } else if (ts.isVariableDeclaration(n) && n.initializer) {
        visitTable(ex, index, state, n.initializer, nextParent, nextChain, depth + 1);
      } else if (ts.isExportAssignment(n)) {
        visitTable(ex, index, state, n.expression, nextParent, nextChain, depth + 1);
      }
    }
  }
}
