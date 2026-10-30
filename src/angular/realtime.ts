// Real time (PLAN 3.3): @microsoft/signalr HubConnectionBuilder().withUrl(...), connection.on(method) and
// invoke/send/stream(method). Output: realtime.connection, realtime.subscribe (contract v1.1), realtime.invoke.
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import type { AnalysisState } from './state.ts';
import { frameworkRef, stringValue, unwrap } from './common.ts';
import { fold, render, canonicalRoute, splitUrl } from './fold.ts';
import { uniformEnvironment } from './http.ts';
import { compareOrdinal } from '../util/canonical.ts';

const SIGNALR = '@microsoft/signalr';

interface Hub {
  route: string | null;
  urlTemplate: string;
  baseAddress: Record<string, unknown> | null;
  evidence: string;
}

function holder(ex: Extractor, call: T.Node): T.Symbol | undefined {
  const ts = ex.ts;
  // Climb the builder chain to the outermost call, then to what it is assigned to.
  let n: T.Node = call;
  while (n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isCallExpression(n.parent) || ts.isParenthesizedExpression(n.parent))) n = n.parent;
  const p = n.parent;
  if (!p) return undefined;
  if (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) return ex.symbolAt(p.name);
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = p.left;
    return ex.symbolAt(ts.isPropertyAccessExpression(left) ? left.name : left);
  }
  return undefined;
}

function classOf(ex: Extractor, node: T.Node): string | null {
  for (let p: T.Node | undefined = node.parent; p; p = p.parent) if (ex.ts.isClassDeclaration(p) && ex.isEntityDeclaration(p)) return ex.ensureEntity(p);
  return null;
}

export function observeRealtime(ex: Extractor, state: AnalysisState): void {
  if (!ex.checker) return;
  const ts = ex.ts;
  const hubs = new Map<T.Symbol, Hub>();
  const connections: Hub[] = [];
  const fc = { isEnvironmentFile: (p: string) => state.env.isEnvironmentFile(p) };
  const files = [...ex.files].sort(([a], [b]) => compareOrdinal(a, b));
  // Pass 1: connections.
  for (const [rel, sf] of files) {
    const visit = (n: T.Node): void => {
      if (ts.isCallExpression(n)) {
        const ref = frameworkRef(ex, n.expression);
        if (ref?.pkg === SIGNALR && ref.name === 'HubConnectionBuilder.withUrl' && n.arguments[0]) {
          const parts = fold(ex, n.arguments[0], fc);
          let baseAddress: Record<string, unknown> | null = null;
          let rest = parts;
          const first = parts[0];
          if (first?.kind === 'env') {
            const apps = state.env.appsUsing(first.file);
            const values = state.env.values(apps, first.file, first.key).map((v) => ({ ...(v.application ? { application: v.application } : {}), configuration: v.configuration, file: v.file, ...(v.secret ? { secret: true } : v.value !== null ? { value: v.value } : {}) }));
            baseAddress = { source: 'environment', key: first.key, file: first.file, values, nameSource: 'configuration' };
            rest = parts.slice(1);
          } else if (first?.kind === 'literal' && splitUrl(first.text)) {
            const split = splitUrl(first.text)!;
            baseAddress = { source: 'literal', value: split.origin, nameSource: 'literal' };
            rest = [{ kind: 'literal', text: split.path }, ...parts.slice(1)];
          }
          rest = uniformEnvironment(state, rest, rel);
          const urlTemplate = render(rest);
          const route = rest.some((p) => p.kind === 'literal') ? canonicalRoute(urlTemplate) : null;
          const evidence = ex.evidence(ex.calleeName(n))!;
          ex.observe('realtime.connection', { route, urlTemplate, baseAddress, client: classOf(ex, n), resolution: route ? 'exact' : 'unresolved' }, [evidence]);
          const s = holder(ex, n);
          if (s) hubs.set(s, { route, urlTemplate, baseAddress, evidence });
          connections.push({ route, urlTemplate, baseAddress, evidence });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    void rel;
  }
  // Pass 2: subscriptions and invocations on known connections.
  for (const [, sf] of files) {
    const visit = (n: T.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const ref = frameworkRef(ex, n.expression);
        const op = ref?.pkg === SIGNALR && ref.name.startsWith('HubConnection.') ? ref.name.slice('HubConnection.'.length) : null;
        if (op && ['on', 'invoke', 'send', 'stream'].includes(op) && n.arguments[0]) {
          const method = stringValue(ex, n.arguments[0]);
          const receiver = unwrap(ex, n.expression.expression);
          const held = hubs.get(ex.symbolAt(ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver)!);
          // A connection made elsewhere (a factory, an injection token): the only connection this context builds, as a candidate.
          const assumed = !held && connections.length === 1 ? connections[0] : undefined;
          const hub = held ?? assumed;
          const fields: Record<string, unknown> = {
            route: hub?.route ?? null,
            hub: hub ? hub.urlTemplate : 'unknown',
            method: method ?? 'unknown',
            client: classOf(ex, n),
            resolution: held && method ? 'exact' : hub || method ? 'candidate' : 'unresolved',
          };
          if (assumed) fields.reason = 'the connection is not built in a field or variable of this context; it is assumed to be the only hub connection the context builds';
          else if (!hub) fields.reason = 'the connection is not built in a field or variable of this context';
          const evidence = [ex.evidence(ex.calleeName(n)), hub?.evidence ?? null];
          if (op === 'on') ex.observe('realtime.subscribe', fields, evidence);
          else ex.observe('realtime.invoke', { ...fields, mode: op }, evidence);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}
