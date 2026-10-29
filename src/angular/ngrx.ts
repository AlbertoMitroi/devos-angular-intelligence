// NgRx (PLAN 3.3): createAction, store.dispatch, createEffect with ofType (and the HTTP calls an effect reaches),
// createReducer with on(). Output: inprocess.send and inprocess.handler (contract v1.1, mechanism `ngrx`).
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import { frameworkRef, unwrap } from './common.ts';
import { compareOrdinal } from '../util/canonical.ts';

export interface PendingEffect {
  ex: Extractor;
  effect: string;
  actions: string[];
  /** Entities called inside the effect body (declared targets). */
  calls: string[];
  evidence: string;
}

function isNgrx(ref: ReturnType<typeof frameworkRef>, pkg: string, name: string): boolean {
  return !!ref && ref.pkg === pkg && ref.name === name;
}

/** The action an expression names: `loadOrders`, `loadOrders()`, `OrdersActions.load`. */
function actionOf(ex: Extractor, e: T.Expression): string | null {
  const ts = ex.ts;
  let u = unwrap(ex, e);
  if (ts.isCallExpression(u)) u = unwrap(ex, u.expression);
  const node = ts.isPropertyAccessExpression(u) ? u.name : u;
  return ex.entityOfSymbol(ex.symbolAt(node));
}

export function observeNgrx(ex: Extractor, pending: PendingEffect[]): void {
  if (!ex.checker) return;
  const ts = ex.ts;
  for (const [, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    const visit = (n: T.Node): void => {
      if (ts.isCallExpression(n)) {
        const ref = frameworkRef(ex, n.expression);
        if (isNgrx(ref, '@ngrx/store', 'createAction') && ts.isVariableDeclaration(n.parent) && ex.isEntityDeclaration(n.parent)) {
          const type = n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0])) ? n.arguments[0].text : null;
          ex.observe('state.action', { action: ex.ensureEntity(n.parent), type, mechanism: 'ngrx' }, [ex.evidence(n.parent.name)]);
        } else if (isNgrx(ref, '@ngrx/store', 'Store.dispatch') && n.arguments[0]) {
          const action = actionOf(ex, n.arguments[0]);
          const sender = ex.containerOf(n);
          if (action && sender) ex.observe('inprocess.send', { request: action, sender, mechanism: 'ngrx' }, [ex.evidence(ex.calleeName(n))]);
        } else if (isNgrx(ref, '@ngrx/effects', 'createEffect')) {
          const effect = ex.containerOf(n);
          if (effect) {
            const actions: string[] = [];
            const calls = new Set<string>();
            const body = n.arguments[0];
            const inner = (m: T.Node): void => {
              if (ts.isCallExpression(m) && isNgrx(frameworkRef(ex, m.expression), '@ngrx/effects', 'ofType')) {
                for (const a of m.arguments) {
                  const id = actionOf(ex, a);
                  if (id) actions.push(id);
                }
              }
              ts.forEachChild(m, inner);
            };
            if (body) inner(body);
            for (const c of ex.calls) {
              if (body && c.node.getSourceFile() === sf && c.node.pos >= body.pos && c.node.end <= body.end) calls.add(c.to);
            }
            pending.push({ ex, effect, actions: [...new Set(actions)].sort(compareOrdinal), calls: [...calls].sort(compareOrdinal), evidence: ex.evidence(ex.calleeName(n))! });
          }
        } else if (isNgrx(ref, '@ngrx/store', 'createReducer')) {
          const reducer = ex.containerOf(n);
          for (const arg of n.arguments.slice(1)) {
            const u = unwrap(ex, arg);
            if (!ts.isCallExpression(u) || !isNgrx(frameworkRef(ex, u.expression), '@ngrx/store', 'on')) continue;
            for (const a of u.arguments.slice(0, -1)) {
              const action = actionOf(ex, a);
              if (action && reducer) ex.observe('inprocess.handler', { request: action, handler: reducer, mechanism: 'ngrx', ext: { ngrx: { role: 'reducer' } } }, [ex.evidence(a)]);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

/**
 * Effects become inprocess.handler observations once HTTP calls exist: an effect reaches the http.call observations whose
 * caller it calls, directly or through declared call targets (depth 3).
 */
export function emitEffects(pending: PendingEffect[], callsFrom: Map<string, Set<string>>, httpByCaller: Map<string, string[]>): void {
  for (const p of pending) {
    const reached = new Set<string>();
    let frontier = new Set(p.calls);
    const seen = new Set<string>();
    for (let depth = 0; depth < 4 && frontier.size > 0; depth++) {
      const next = new Set<string>();
      for (const f of frontier) {
        if (seen.has(f)) continue;
        seen.add(f);
        for (const h of httpByCaller.get(f) ?? []) reached.add(h);
        for (const t of callsFrom.get(f) ?? []) next.add(t);
      }
      frontier = next;
    }
    const httpCalls = [...reached].sort(compareOrdinal);
    for (const action of p.actions) {
      p.ex.observe('inprocess.handler', { request: action, handler: p.effect, mechanism: 'ngrx', ext: { ngrx: { role: 'effect', calls: p.calls, httpCalls } } }, [p.evidence]);
    }
    if (p.actions.length === 0) {
      p.ex.gen.diagnostic('info', 'effect-actions-unknown', p.effect, 'unknown', `Effect ${p.effect} has no ofType() with resolvable actions.`);
    }
  }
}
