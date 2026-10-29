// Shared helpers for the Angular adapters. Framework calls are recognized by resolved symbol (package and qualified
// name), never by text; in syntax mode, by the import that brings the name in (method `syntax`).
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import { packageOf } from '../extract/core.ts';

export interface FrameworkRef {
  pkg: string;
  /** Qualified name inside the package without overload suffix, for example `HttpClient.get`. */
  name: string;
  decl: T.Node | null;
}

export function unwrap(ex: Extractor, e: T.Expression): T.Expression {
  const ts = ex.ts;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e))) {
    e = (e as any).expression;
  }
  return e;
}

/** The framework symbol an expression refers to, when it is declared in a package (by checker or by import). */
export function frameworkRef(ex: Extractor, expr: T.Node): FrameworkRef | null {
  const ts = ex.ts;
  const nameNode = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  if (ex.checker) {
    const symbol = ex.resolveAlias(ex.symbolAt(nameNode));
    const decl = symbol?.declarations?.[0];
    if (!decl) return null;
    const pkg = packageOf(decl.getSourceFile().fileName);
    if (!pkg) return null;
    const node = ex.entityNodeOf(decl);
    const name = ex.isEntityDeclaration(node) ? ex.symbolPath(node).replace(/\(.*\)$/, '') : symbol!.name;
    return { pkg: pkg.name, name, decl: node };
  }
  if (!ts.isIdentifier(nameNode)) return null;
  const sf = expr.getSourceFile();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text.startsWith('.')) continue;
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text === nameNode.text) {
          const spec = s.moduleSpecifier.text;
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          return { pkg, name: (el.propertyName ?? el.name).text, decl: null };
        }
      }
    }
  }
  return null;
}

export function isAngular(ref: FrameworkRef | null, ...names: string[]): boolean {
  return !!ref && ref.pkg.startsWith('@angular/') && (names.length === 0 || names.includes(ref.name));
}

export interface DecoratorInfo {
  name: string;
  pkg: string;
  node: T.Decorator;
  call: T.CallExpression | null;
  arg: T.ObjectLiteralExpression | null;
}

export function angularDecorators(ex: Extractor, node: T.Node): DecoratorInfo[] {
  const ts = ex.ts;
  const out: DecoratorInfo[] = [];
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  for (const d of decorators) {
    const call = ts.isCallExpression(d.expression) ? d.expression : null;
    const ref = frameworkRef(ex, call ? call.expression : d.expression);
    if (!ref || !ref.pkg.startsWith('@angular/')) continue;
    const first = call?.arguments[0];
    const arg = first && ts.isObjectLiteralExpression(unwrap(ex, first)) ? (unwrap(ex, first) as T.ObjectLiteralExpression) : null;
    out.push({ name: ref.name, pkg: ref.pkg, node: d, call, arg });
  }
  return out;
}

export function prop(ex: Extractor, obj: T.ObjectLiteralExpression | null | undefined, name: string): T.Expression | undefined {
  if (!obj) return undefined;
  const ts = ex.ts;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ex.memberName(p.name) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (ts.isMethodDeclaration(p) && ex.memberName(p.name) === name) return p as unknown as T.Expression;
  }
  return undefined;
}

export function propNode(ex: Extractor, obj: T.ObjectLiteralExpression | null | undefined, name: string): T.ObjectLiteralElementLike | undefined {
  if (!obj) return undefined;
  return obj.properties.find((p) => (p as any).name && ex.memberName((p as any).name) === name);
}

export function stringValue(ex: Extractor, e: T.Expression | undefined): string | null {
  if (!e) return null;
  const ts = ex.ts;
  const u = unwrap(ex, e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ex.checker && (ts.isIdentifier(u) || ts.isPropertyAccessExpression(u))) {
    const decl = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(u) ? u.name : u))?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isEnumMember(decl)) && decl.initializer && decl.initializer !== e) {
      return stringValue(ex, decl.initializer);
    }
  }
  return null;
}

export function booleanValue(ex: Extractor, e: T.Expression | undefined): boolean | null {
  if (!e) return null;
  const k = unwrap(ex, e).kind;
  if (k === ex.ts.SyntaxKind.TrueKeyword) return true;
  if (k === ex.ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/**
 * Elements of an array expression: follows identifiers to `const` initializers, spreads and nested arrays
 * (depth-limited). Items it cannot see into are returned as they are.
 */
export function arrayItems(ex: Extractor, e: T.Expression | undefined, depth = 0): T.Expression[] {
  if (!e || depth > 6) return [];
  const ts = ex.ts;
  const u = unwrap(ex, e);
  if (ts.isArrayLiteralExpression(u)) {
    const out: T.Expression[] = [];
    for (const el of u.elements) {
      if (ts.isSpreadElement(el)) out.push(...arrayItems(ex, el.expression, depth + 1));
      else if (ts.isArrayLiteralExpression(unwrap(ex, el))) out.push(...arrayItems(ex, el, depth + 1));
      else out.push(el);
    }
    return out;
  }
  const init = initializerOf(ex, u);
  if (init) return arrayItems(ex, init, depth + 1);
  return [u];
}

/** The initializer of the variable or readonly property an identifier refers to. */
export function initializerOf(ex: Extractor, e: T.Expression): T.Expression | undefined {
  const ts = ex.ts;
  if (!ex.checker) {
    if (!ts.isIdentifier(e)) return undefined;
    for (const s of e.getSourceFile().statements) {
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === e.text) return d.initializer;
    }
    return undefined;
  }
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
  const decl = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(e) ? e.name : e))?.valueDeclaration;
  if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) return decl.initializer;
  return undefined;
}

/** The class declaration an expression refers to (source or package declaration file). */
export function classOf(ex: Extractor, e: T.Expression): T.ClassDeclaration | null {
  const ts = ex.ts;
  const u = unwrap(ex, e);
  if (!ex.checker) {
    if (!ts.isIdentifier(u)) return null;
    for (const s of u.getSourceFile().statements) if (ts.isClassDeclaration(s) && s.name?.text === u.text) return s;
    return null;
  }
  const symbol = ex.resolveAlias(ex.symbolAt(ts.isPropertyAccessExpression(u) ? u.name : u));
  const decl = symbol?.declarations?.find((d) => ts.isClassDeclaration(d));
  return (decl as T.ClassDeclaration) ?? null;
}

export function relPathOf(ex: Extractor, node: T.Node): string | null {
  return ex.rel(node.getSourceFile().fileName);
}

/** Static Ivy metadata of a package class: ɵcmp, ɵdir, ɵpipe or ɵmod type arguments. */
export function ivyMetadata(ex: Extractor, cls: T.ClassDeclaration): { kind: string; args: readonly T.TypeNode[] } | null {
  const ts = ex.ts;
  for (const m of cls.members) {
    if (!ts.isPropertyDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
    const kind = { 'ɵcmp': 'component', 'ɵdir': 'directive', 'ɵpipe': 'pipe', 'ɵmod': 'ngModule' }[m.name.text];
    if (!kind || !m.type || !ts.isTypeReferenceNode(m.type)) continue;
    return { kind, args: m.type.typeArguments ?? [] };
  }
  return null;
}

export function literalTypeText(ex: Extractor, t: T.TypeNode | undefined): string | null {
  if (!t) return null;
  const ts = ex.ts;
  if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return t.literal.text;
  return null;
}
