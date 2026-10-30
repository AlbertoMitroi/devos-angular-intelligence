// HTTP (PLAN 3.3): HttpClient calls (and caller-declared client wrappers, decision A10) folded into URL templates;
// base addresses from environment files per configuration (D20), interceptors that prefix URLs, proxy.conf targets.
// Output: http.call with canonicalRoute, http.interceptor, http.proxy.
import type * as T from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Extractor } from '../extract/core.ts';
import type { AnalysisState, HttpClientConvention } from './state.ts';
import type { ProjectInfo } from '../discovery.ts';
import { readJsonc } from '../discovery.ts';
import { frameworkRef, prop, stringValue, unwrap } from './common.ts';
import { type Part, fold, render, canonicalRoute, splitUrl } from './fold.ts';
import { isSecret } from '../secrets.ts';
import type { Resolution } from '../model.ts';
import { compareOrdinal } from '../util/canonical.ts';
import engineTs from 'typescript';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'jsonp'];

export interface PendingCall {
  ex: Extractor;
  file: string;
  method: string;
  parts: Part[];
  client: string | null;
  caller: string | null;
  evidence: string;
  via: string;
  convention: string | null;
  /** Explicit base from a convention (environment key). */
  conventionBase: { key: string; apiName: string } | null;
}

export interface BaseValue {
  application?: string | null;
  configuration: string;
  file: string;
  value?: string;
  secret?: boolean;
}

function classOfNode(ex: Extractor, node: T.Node): string | null {
  for (let p: T.Node | undefined = node.parent; p; p = p.parent) {
    if (ex.ts.isClassDeclaration(p) && ex.isEntityDeclaration(p)) return ex.ensureEntity(p);
  }
  return null;
}

export function collectHttp(ex: Extractor, state: AnalysisState, pending: PendingCall[]): void {
  if (!ex.checker) return;
  const ts = ex.ts;
  const conventions = state.config.http?.clients ?? [];
  const fc = { isEnvironmentFile: (p: string) => state.env.isEnvironmentFile(p) };
  for (const [rel, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    const visit = (node: T.Node): void => {
      if (ts.isCallExpression(node)) {
        const ref = frameworkRef(ex, node.expression);
        if (ref && ref.pkg === '@angular/common' && ref.name.startsWith('HttpClient.')) {
          const verb = ref.name.slice('HttpClient.'.length);
          let method: string | null = null;
          let url: T.Expression | undefined;
          if (VERBS.includes(verb)) {
            method = verb.toUpperCase();
            url = node.arguments[0];
          } else if (verb === 'request') {
            const first = node.arguments[0] ? unwrap(ex, node.arguments[0]) : undefined;
            if (first && ts.isNewExpression(first) && frameworkRef(ex, first.expression)?.name === 'HttpRequest') {
              method = (stringValue(ex, first.arguments?.[0]) ?? '{}').toUpperCase();
              url = first.arguments?.[1];
            } else {
              method = (stringValue(ex, first) ?? '{}').toUpperCase();
              url = node.arguments[1];
            }
          }
          if (method && url) {
            pending.push({ ex, file: rel, method, parts: fold(ex, url, fc), client: classOfNode(ex, node), caller: ex.containerOf(node), evidence: ex.evidence(ex.calleeName(node))!, via: 'HttpClient', convention: null, conventionBase: null });
          }
        } else if (ref) {
          const c = conventions.find((x) => x.package === ref.pkg && x.method === ref.name);
          if (c) conventionCall(ex, state, c, node, rel, pending, fc);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

function conventionCall(ex: Extractor, state: AnalysisState, c: HttpClientConvention, node: T.CallExpression, rel: string, pending: PendingCall[], fc: { isEnvironmentFile(p: string): boolean }): void {
  const ts = ex.ts;
  const request = node.arguments[c.request.argument] ? unwrap(ex, node.arguments[c.request.argument]) : undefined;
  if (!request || !ts.isObjectLiteralExpression(request)) return;
  const url = prop(ex, request, c.request.url);
  if (!url) return;
  const method = c.request.method ? (stringValue(ex, prop(ex, request, c.request.method)) ?? '{}').toUpperCase() : '{}';
  let conventionBase: PendingCall['conventionBase'] = null;
  if (c.base) {
    const baseArg = node.arguments[c.base.argument] ? unwrap(ex, node.arguments[c.base.argument]) : undefined;
    const apiName = (baseArg && ts.isObjectLiteralExpression(baseArg) ? stringValue(ex, prop(ex, baseArg, c.base.property)) : null) ?? c.base.default ?? null;
    if (apiName) conventionBase = { key: c.base.environmentKey.replace('{}', apiName), apiName };
  }
  pending.push({
    ex,
    file: rel,
    method,
    parts: fold(ex, url, fc),
    client: classOfNode(ex, node),
    caller: ex.containerOf(node),
    evidence: ex.gen.addEvidence(rel, ex.nodeSpan(ex.calleeName(node)), 'configured-convention', ex.contextId),
    via: 'convention',
    convention: `${c.package}#${c.method}`,
    conventionBase,
  });
}

// ---------- interceptors ----------

export function collectInterceptors(ex: Extractor, state: AnalysisState): void {
  if (!ex.checker) return;
  const ts = ex.ts;
  for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    const candidates: { entity: string; fn: T.SignatureDeclaration & { body?: T.Node }; anchor: T.Node }[] = [];
    for (const s of sf.statements) {
      if (ts.isClassDeclaration(s) && ex.isEntityDeclaration(s)) {
        const implementsInterceptor = (s.heritageClauses ?? []).some((h) => h.token === ts.SyntaxKind.ImplementsKeyword && h.types.some((t) => frameworkRef(ex, t.expression)?.name === 'HttpInterceptor'));
        const intercept = s.members.find((m): m is T.MethodDeclaration => ts.isMethodDeclaration(m) && ex.memberName(m.name) === 'intercept' && !!m.body);
        if (implementsInterceptor && intercept) candidates.push({ entity: ex.ensureEntity(s)!, fn: intercept, anchor: s.name ?? s });
      }
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          const init = d.initializer ? unwrap(ex, d.initializer) : undefined;
          if (!init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
          const typed = d.type && ts.isTypeReferenceNode(d.type) && frameworkRef(ex, d.type.typeName as T.Node)?.name === 'HttpInterceptorFn';
          if (typed && ex.isEntityDeclaration(d)) candidates.push({ entity: ex.ensureEntity(d)!, fn: init, anchor: d.name });
        }
      }
      if (ts.isFunctionDeclaration(s) && s.body && s.parameters.length === 2 && ex.isEntityDeclaration(s)) {
        const t = s.parameters[1].type;
        if (t && ts.isTypeReferenceNode(t) && frameworkRef(ex, t.typeName as T.Node)?.name === 'HttpHandlerFn') candidates.push({ entity: ex.ensureEntity(s)!, fn: s, anchor: s.name ?? s });
      }
    }
    for (const c of candidates) {
      const reqParam = c.fn.parameters[0];
      if (!reqParam || !ts.isIdentifier(reqParam.name)) continue;
      const reqSymbol = ex.symbolAt(reqParam.name);
      const isRequestUrl = (e: T.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === 'url' && ts.isIdentifier(e.expression) && ex.symbolAt(e.expression) === reqSymbol;
      const fc = { isEnvironmentFile: (p: string) => state.env.isEnvironmentFile(p), isRequestUrl };
      const visit = (n: T.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'clone' && ts.isIdentifier(n.expression.expression) && ex.symbolAt(n.expression.expression) === reqSymbol) {
          const arg = n.arguments[0] ? unwrap(ex, n.arguments[0]) : undefined;
          const url = arg && ts.isObjectLiteralExpression(arg) ? prop(ex, arg, 'url') : undefined;
          if (url) {
            const parts = fold(ex, url, fc);
            const at = parts.findIndex((p) => p.kind === 'requestUrl');
            if (at > 0) {
              const prefix = parts.slice(0, at);
              const registered = state.registeredInterceptors.has(c.entity);
              const obs = ex.observe('http.interceptor', { interceptor: c.entity, urlPrefix: render(prefix), registered }, [ex.evidence(url)]);
              if (obs) state.interceptors.push({ observation: obs, project: ex.project.path, prefix, registered, entity: c.entity });
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      if (c.fn.body) visit(c.fn.body);
    }
  }
}

// ---------- proxy configuration ----------

export interface ProxyRule {
  project: string;
  configuration: string;
  file: string;
  context: string;
  target: string | null;
  secret: boolean;
  pathRewrite: Record<string, string>;
  observation: string | null;
}

export function collectProxies(ex: Extractor, project: ProjectInfo): ProxyRule[] {
  const rules: ProxyRule[] = [];
  for (const { configuration, file } of project.proxyConfigs) {
    if (!ex.gen.hasBlob(file)) {
      ex.gen.diagnostic('warning', 'proxy-config-missing', file, 'partial', `Proxy configuration '${file}' of ${project.name} is not in the repository.`);
      continue;
    }
    const text = readFileSync(join(ex.workRoot, file), 'utf8');
    let config: unknown;
    if (file.endsWith('.json')) {
      try {
        config = readJsonc(text);
      } catch (e) {
        ex.gen.diagnostic('warning', 'proxy-config-unreadable', file, 'failed', `'${file}' could not be parsed: ${(e as Error).message}`);
        continue;
      }
    } else {
      config = literalModuleExport(text);
      if (config === undefined) {
        ex.gen.diagnostic('info', 'proxy-config-unsupported', file, 'unsupported', `'${file}' is not a literal object or array export; it is not evaluated (the engine never runs repository code).`);
        continue;
      }
    }
    const entries: { context: string; options: any }[] = [];
    if (Array.isArray(config)) {
      for (const item of config) for (const ctx of [].concat(item?.context ?? [])) if (typeof ctx === 'string') entries.push({ context: ctx, options: item });
    } else if (config && typeof config === 'object') {
      for (const [ctx, options] of Object.entries(config)) entries.push({ context: ctx, options });
    }
    const lines = text.split('\n');
    for (const { context, options } of entries.sort((a, b) => compareOrdinal(a.context, b.context))) {
      const target = typeof options?.target === 'string' ? options.target : null;
      const secret = isSecret('target', target);
      const pathRewrite: Record<string, string> = {};
      for (const [k, v] of Object.entries(options?.pathRewrite ?? {})) if (typeof v === 'string') pathRewrite[k] = v;
      let line = lines.findIndex((l) => l.includes(`"${context}"`) || l.includes(`'${context}'`));
      if (line < 0) line = 0;
      const col = Math.max(0, lines[line].indexOf(context)) + 1;
      const ev = ex.evidenceAt(file, { startLine: line + 1, startColumn: col, endLine: line + 1, endColumn: col + context.length }, 'config');
      const observation = ex.observe('http.proxy', {
        prefix: context,
        target: secret ? null : target,
        secret,
        configuration,
        file,
        pathRewrite,
        nameSource: 'configuration',
      }, [ev]);
      rules.push({ project: project.path, configuration, file, context, target: secret ? null : target, secret, pathRewrite, observation });
    }
  }
  return rules;
}

/** `module.exports = {...}`, `export default [...]` or `const PROXY_CONFIG = ...; module.exports = PROXY_CONFIG` with literal values. */
function literalModuleExport(text: string): unknown {
  const ts = engineTs;
  const sf = ts.createSourceFile('proxy.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const locals = new Map<string, T.Expression>();
  let exported: T.Expression | undefined;
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText() === 'module.exports') exported = s.expression.right;
    if (ts.isExportAssignment(s)) exported = s.expression;
  }
  const value = (e: T.Expression | undefined, depth = 0): unknown => {
    if (!e || depth > 10) return undefined;
    if (ts.isIdentifier(e) && locals.has(e.text)) return value(locals.get(e.text), depth + 1);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => value(x, depth + 1));
    if (ts.isObjectLiteralExpression(e)) {
      const o: Record<string, unknown> = {};
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) o[p.name.text] = value(p.initializer, depth + 1);
      }
      return o;
    }
    return undefined;
  };
  return value(exported);
}

// ---------- emission ----------

function baseFromEnvironment(state: AnalysisState, file: string, key: string, callFile: string): { values: BaseValue[]; found: boolean } {
  const apps = state.env.appsUsing(file);
  const including = state.appsIncluding(callFile);
  const relevant = apps.filter((a) => including.length === 0 || including.some((i) => i.project.path === a.project.path));
  const values = state.env.values(relevant.length > 0 ? relevant : apps, file, key);
  return { values: values.map(toBaseValue), found: values.length > 0 && values.every((v) => v.found) };
}

function toBaseValue(v: { application: string | null; configuration: string; file: string; value: string | null; secret: boolean }): BaseValue {
  const out: BaseValue = { configuration: v.configuration, file: v.file };
  if (v.application !== null) out.application = v.application;
  if (v.secret) out.secret = true;
  else if (v.value !== null) out.value = v.value;
  return out;
}

/**
 * Environment references after the base (`${environment.apiUrl}${environment.hubPath}`) become literals when the key has
 * the same non-secret value in every configuration of the including applications (D20: a destination from configuration).
 */
export function uniformEnvironment(state: AnalysisState, parts: Part[], callFile: string): Part[] {
  return parts.map((p) => {
    if (p.kind !== 'env') return p;
    const { values, found } = baseFromEnvironment(state, p.file, p.key, callFile);
    const distinct = new Set(values.map((v) => v.value));
    return found && values.length > 0 && values.every((v) => v.value !== undefined && !v.secret) && distinct.size === 1 ? { kind: 'literal', text: values[0].value! } : p;
  });
}

/** The common path of every base value (http://host/api -> /api), or null when they differ or are unknown. */
function basePath(values: BaseValue[]): string | null {
  const paths = new Set<string>();
  for (const v of values) {
    if (v.value === undefined) return null;
    const split = splitUrl(v.value);
    paths.add(split ? split.path.replace(/\/+$/, '') : v.value.replace(/\/+$/, ''));
  }
  return paths.size === 1 ? [...paths][0] : null;
}

export function emitHttpCalls(state: AnalysisState, pending: PendingCall[], proxies: ProxyRule[]): void {
  for (const call of pending) {
    const { ex } = call;
    let parts = [...call.parts];
    let baseAddress: Record<string, unknown> | null = null;
    let resolution: Resolution = 'exact';
    const reasons: string[] = [];
    const evidence = [call.evidence];
    let prefixPath = '';
    const first = parts[0];
    if (call.conventionBase) {
      const apps = state.appsIncluding(call.file);
      const envFiles = [...new Set(apps.flatMap((a) => [a.defaultFile, ...a.configurations.map((c) => c.file)]))];
      const raw = state.env.values(apps, null, call.conventionBase.key);
      const values = raw.map(toBaseValue);
      const missing = [...new Set(raw.filter((v) => !v.found).map((v) => v.file))].sort(compareOrdinal);
      baseAddress = { source: 'convention', key: call.conventionBase.key, values, nameSource: 'configuration' };
      if (raw.length === 0 || missing.length > 0) {
        resolution = 'candidate';
        reasons.push(apps.length === 0 ? 'no application includes this file, so its environment is unknown' : `environment key '${call.conventionBase.key}' is missing in ${missing.length} of ${envFiles.length} environment file(s) of the including applications (${missing.join(', ')})`);
      }
      const bp = basePath(values);
      if (bp) prefixPath = bp;
    } else if (first?.kind === 'env') {
      const { values, found } = baseFromEnvironment(state, first.file, first.key, call.file);
      baseAddress = { source: 'environment', key: first.key, file: first.file, values, nameSource: 'configuration' };
      if (!found) {
        resolution = 'candidate';
        reasons.push(`environment key '${first.key}' is not a literal in every configuration`);
      }
      const bp = basePath(values);
      if (bp !== null) prefixPath = bp;
      else if (values.length > 1) reasons.push('the base path differs between configurations; canonicalRoute is relative to the base address');
      parts = parts.slice(1);
    } else if (first?.kind === 'literal' && splitUrl(first.text)) {
      const split = splitUrl(first.text)!;
      baseAddress = { source: 'literal', value: split.origin, nameSource: 'literal' };
      parts = [{ kind: 'literal', text: split.path }, ...parts.slice(1)];
    } else if (first?.kind === 'param') {
      baseAddress = { source: 'unknown', expression: first.source };
      resolution = 'candidate';
      reasons.push(`the URL starts with '${first.source}', which could not be folded`);
      parts = parts.slice(1);
    } else {
      // Relative URL: an interceptor prefix, then the dev-server proxy, may apply.
      const apps = new Set(state.appsIncluding(call.file).map((a) => a.project.path));
      const interceptors = state.interceptors.filter((i) => i.registered && (apps.has(i.project) || i.project === ex.project.path));
      if (interceptors.length > 0) {
        const i = interceptors[0];
        const head = i.prefix[0];
        if (head?.kind === 'env') {
          const { values, found } = baseFromEnvironment(state, head.file, head.key, call.file);
          baseAddress = { source: 'interceptor', interceptor: i.entity, key: head.key, file: head.file, values, nameSource: 'configuration' };
          if (!found) resolution = 'candidate';
          const bp = basePath(values);
          if (bp) prefixPath = bp;
          parts = [...i.prefix.slice(1), ...parts];
        } else if (head?.kind === 'literal' && splitUrl(head.text)) {
          const split = splitUrl(head.text)!;
          baseAddress = { source: 'interceptor', interceptor: i.entity, value: split.origin, nameSource: 'literal' };
          parts = [{ kind: 'literal', text: split.path }, ...i.prefix.slice(1), ...parts];
        } else {
          baseAddress = { source: 'interceptor', interceptor: i.entity };
          parts = [...i.prefix, ...parts];
        }
        evidence.push(...ex.gen.observations.get(i.observation) ? (ex.gen.observations.get(i.observation)!.evidence as string[]) : []);
        if (interceptors.length > 1) {
          resolution = 'ambiguous';
          reasons.push(`${interceptors.length} registered interceptors prefix request URLs`);
        }
      }
    }
    parts = uniformEnvironment(state, parts, call.file);
    const template = render(parts);
    let route = canonicalRoute(template);
    if (prefixPath) route = canonicalRoute(prefixPath + '/' + route);
    if (!baseAddress) {
      const apps = new Set(state.appsIncluding(call.file).map((a) => a.project.path));
      const rules = proxies.filter((r) => (apps.has(r.project) || r.project === ex.project.path) && matchesContext(route, r.context));
      if (rules.length > 0) {
        baseAddress = {
          source: 'proxy',
          prefix: rules[0].context,
          values: rules.map((r) => ({ application: r.project, configuration: r.configuration, file: r.file, ...(r.secret ? { secret: true } : r.target ? { value: r.target } : {}) })),
          nameSource: 'configuration',
        };
        for (const r of rules) if (r.observation) evidence.push(...((ex.gen.observations.get(r.observation)?.evidence as string[]) ?? []));
        const rewrite = rules[0].pathRewrite;
        const pattern = Object.keys(rewrite)[0];
        if (pattern) {
          try {
            route = canonicalRoute(route.replace(new RegExp(pattern), rewrite[pattern]));
          } catch {
            reasons.push(`proxy pathRewrite '${pattern}' is not a valid regular expression`);
          }
        }
      }
    }
    let urlTemplate = template;
    let routeOut: string | null = route;
    if (parts.every((p) => p.kind !== 'literal') && (!baseAddress || baseAddress.source === 'unknown')) {
      // Nothing of the path is known: no route at all rather than '/' (unknown is not empty).
      resolution = 'unresolved';
      urlTemplate = render(call.parts);
      routeOut = null;
      if (!baseAddress) reasons.push('the URL could not be folded to a template');
    }
    const fields: Record<string, unknown> = {
      method: call.method,
      urlTemplate,
      canonicalRoute: routeOut,
      baseAddress,
      client: call.client,
      caller: call.caller,
      resolution,
      ext: { angular: { via: call.via, ...(call.convention ? { convention: call.convention } : {}) } },
    };
    if (reasons.length > 0) fields.reason = reasons.join('; ');
    ex.observe('http.call', fields, evidence);
  }
}

function matchesContext(route: string, context: string): boolean {
  const c = context.replace(/\/\*\*?$/, '').replace(/\/+$/, '').toLowerCase();
  return c === '' || route === c || route.startsWith(c + '/');
}
