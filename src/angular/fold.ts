// Folding of URL expressions into templates (PLAN 3.3 HTTP): string literals, template literals, concatenation,
// constants and initializers, and `environment.*` references (kept as references, never inlined).
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import { unwrap } from './common.ts';

export type Part =
  | { kind: 'literal'; text: string }
  | { kind: 'param'; source: string }
  | { kind: 'env'; file: string; key: string }
  | { kind: 'requestUrl' };

export interface FoldContext {
  isEnvironmentFile(path: string): boolean;
  /** Recognizes the `url` of an intercepted request (interceptors). */
  isRequestUrl?(e: T.Expression): boolean;
}

export function fold(ex: Extractor, e: T.Expression, fc: FoldContext, depth = 0): Part[] {
  const ts = ex.ts;
  const u = unwrap(ex, e);
  if (fc.isRequestUrl?.(u)) return [{ kind: 'requestUrl' }];
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return [{ kind: 'literal', text: u.text }];
  if (ts.isTemplateExpression(u)) {
    const parts: Part[] = [{ kind: 'literal', text: u.head.text }];
    for (const span of u.templateSpans) {
      parts.push(...fold(ex, span.expression, fc, depth + 1));
      parts.push({ kind: 'literal', text: span.literal.text });
    }
    return merge(parts);
  }
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return merge([...fold(ex, u.left, fc, depth + 1), ...fold(ex, u.right, fc, depth + 1)]);
  }
  if ((ts.isIdentifier(u) || ts.isPropertyAccessExpression(u)) && ex.checker && depth < 8) {
    const env = environmentReference(ex, u, fc);
    if (env) return [env];
    const symbol = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(u) ? u.name : u));
    const decl = symbol?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer && isStable(ex, decl)) {
      return fold(ex, decl.initializer, fc, depth + 1);
    }
    if (decl && ts.isEnumMember(decl) && decl.initializer) return fold(ex, decl.initializer, fc, depth + 1);
  }
  return [{ kind: 'param', source: u.getText().replace(/\s+/g, ' ').slice(0, 80) }];
}

/** A `const` variable, or a class property with an initializer that is never assigned elsewhere in its file. */
function isStable(ex: Extractor, decl: T.VariableDeclaration | T.PropertyDeclaration): boolean {
  const ts = ex.ts;
  if (ts.isVariableDeclaration(decl)) return (decl.parent.flags & ts.NodeFlags.Const) !== 0;
  const name = ex.memberName(decl.name);
  let assigned = false;
  const visit = (n: T.Node): void => {
    if (assigned) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === name && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      assigned = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(decl.parent);
  return !assigned;
}

function environmentReference(ex: Extractor, e: T.Expression, fc: FoldContext): Part | null {
  const ts = ex.ts;
  const chain: string[] = [];
  let cur: T.Expression = e;
  while (ts.isPropertyAccessExpression(cur)) {
    chain.unshift(cur.name.text);
    cur = unwrap(ex, cur.expression);
  }
  if (!ts.isIdentifier(cur)) return null;
  const symbol = ex.resolveAlias(ex.symbolAt(cur));
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  const file = ex.rel(decl.getSourceFile().fileName);
  if (!file || !fc.isEnvironmentFile(file)) return null;
  return { kind: 'env', file, key: [decl.name.text, ...chain].join('.') };
}

function merge(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.kind === 'literal' && last?.kind === 'literal') out[out.length - 1] = { kind: 'literal', text: last.text + p.text };
    else if (!(p.kind === 'literal' && p.text === '')) out.push(p);
  }
  return out;
}

export function render(parts: Part[]): string {
  return parts.map((p) => (p.kind === 'literal' ? p.text : p.kind === 'env' ? `{${p.key}}` : p.kind === 'requestUrl' ? '{request.url}' : '{}')).join('');
}

/**
 * Contract canonical route: one leading '/', lower-case literals, parameters as `{}`, no query, no trailing '/'.
 * Returns null when the template has no path (only a base).
 */
export function canonicalRoute(template: string): string {
  let path = template.replace(/[?#].*$/, '');
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes('{}') ? (s === '{}' ? '{}' : s.replace(/\{\}/g, '{}').toLowerCase()) : s.toLowerCase()));
  return '/' + segments.join('/');
}

/** Splits an absolute URL into origin and path. */
export function splitUrl(url: string): { origin: string; path: string } | null {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(url);
  return m ? { origin: m[1], path: m[2] } : null;
}
