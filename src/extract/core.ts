// Extraction for one analysis context (PLAN 3.2): entities, declarations, contains, references with usage,
// calls_declared_target, inherits, implements, overrides. Works with a type checker (method `semantic`) or with the
// parser only (method `syntax`, PLAN 3.4).
import type * as T from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import type { TS, NG, Selected } from '../toolchain.ts';
import type { Generation, Span, Method, Resolution } from '../model.ts';
import { type ProjectInfo, ownerOf } from '../discovery.ts';
import { compareOrdinal } from '../util/canonical.ts';

export interface PackageInfo {
  name: string;
  version: string;
  root: string;
}

const packageCache = new Map<string, PackageInfo | null>();

/** Package that contains an absolute file path inside node_modules. */
export function packageOf(fileName: string): PackageInfo | null {
  const norm = fileName.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = norm.slice(i + '/node_modules/'.length).split('/');
  const nameParts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  const root = norm.slice(0, i + '/node_modules/'.length) + nameParts.join('/');
  if (packageCache.has(root)) return packageCache.get(root)!;
  let info: PackageInfo | null = null;
  // Nested package.json files (secondary entry points such as @angular/common/http) do not change the package identity.
  const pkgJson = join(root, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const json = JSON.parse(readFileSync(pkgJson, 'utf8'));
      info = { name: String(json.name ?? nameParts.join('/')), version: String(json.version ?? 'unknown'), root };
    } catch {
      info = { name: nameParts.join('/'), version: 'unknown', root };
    }
  }
  packageCache.set(root, info);
  return info;
}

export function stripExtension(path: string): string {
  return path.replace(/(\.d)?\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface ExtractOptions {
  gen: Generation;
  ts: TS;
  program: T.Program | null;
  project: ProjectInfo;
  projects: ProjectInfo[];
  contextId: string;
  workRoot: string;
  method: Method;
}

export class Extractor {
  readonly gen: Generation;
  readonly ts: TS;
  readonly program: T.Program | null;
  readonly checker: T.TypeChecker | null;
  readonly project: ProjectInfo;
  readonly projects: ProjectInfo[];
  readonly contextId: string;
  readonly workRoot: string;
  readonly method: Method;
  /** Files of this context to extract (repository-relative path to source file). */
  readonly files = new Map<string, T.SourceFile>();
  /** Every repository file the context's program (or parser) loaded; a file is extracted by one context only. */
  readonly allFiles: [string, T.SourceFile][] = [];
  /** The @angular/compiler selected for this context's templates. */
  angular: Selected<NG> | null = null;
  /** call relation targets by evidence, used by adapters (NgRx effects, possible runtime targets). */
  readonly calls: { from: string; to: string; evidence: string; node: T.Node }[] = [];
  private readonly localExports = new Map<T.SourceFile, Set<string>>();

  constructor(o: ExtractOptions) {
    this.gen = o.gen;
    this.ts = o.ts;
    this.program = o.program;
    this.checker = o.program ? o.program.getTypeChecker() : null;
    this.project = o.project;
    this.projects = o.projects;
    this.contextId = o.contextId;
    this.workRoot = o.workRoot;
    this.method = o.method;
  }

  // ---------- locations ----------

  rel(fileName: string): string | null {
    const norm = fileName.replace(/\\/g, '/');
    const root = this.workRoot.replace(/\\/g, '/') + '/';
    if (!norm.startsWith(root)) return null;
    const rel = norm.slice(root.length);
    return this.gen.hasBlob(rel) && !rel.split('/').includes('node_modules') ? rel : null;
  }

  span(sf: T.SourceFile, start: number, end: number): Span {
    const a = this.ts.getLineAndCharacterOfPosition(sf, start);
    const b = this.ts.getLineAndCharacterOfPosition(sf, Math.max(start, end));
    return { startLine: a.line + 1, startColumn: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
  }

  nodeSpan(node: T.Node): Span {
    const sf = node.getSourceFile();
    return this.span(sf, node.getStart(sf), node.getEnd());
  }

  evidence(node: T.Node, method: Method = this.method): string | null {
    const sf = node.getSourceFile();
    const rel = this.rel(sf.fileName);
    if (!rel) return null;
    return this.gen.addEvidence(rel, this.nodeSpan(node), method, this.contextId);
  }

  // ---------- identity ----------

  projectPathOf(rel: string): string {
    return (ownerOf(this.projects, rel) ?? this.project).path;
  }

  moduleId(sf: T.SourceFile): string | null {
    const rel = this.rel(sf.fileName);
    if (rel) return `ts:${this.projectPathOf(rel)}:${stripExtension(rel)}#`;
    const pkg = packageOf(sf.fileName);
    if (!pkg || this.isDefaultLib(sf)) return null;
    const inPkg = sf.fileName.replace(/\\/g, '/').slice(pkg.root.length + 1);
    return `ts:pkg:${pkg.name}@${pkg.version}:${stripExtension(inPkg)}#`;
  }

  isDefaultLib(sf: T.SourceFile): boolean {
    if (this.program && this.program.isSourceFileDefaultLibrary(sf)) return true;
    return /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(sf.fileName.replace(/\\/g, '/'));
  }

  /** Whether a node declares an entity (PLAN 3.2): module-level or namespace-level declarations and their members. */
  isEntityDeclaration(node: T.Node): boolean {
    const ts = this.ts;
    const p = node.parent;
    if (!p) return false;
    const topLevel = ts.isSourceFile(p) || ts.isModuleBlock(p);
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isFunctionDeclaration(node)) {
      return topLevel;
    }
    if (ts.isModuleDeclaration(node)) return topLevel && ts.isIdentifier(node.name);
    if (ts.isExportAssignment(node)) return ts.isSourceFile(p) && !node.isExportEquals;
    if (ts.isVariableDeclaration(node)) {
      const statement = p.parent;
      return ts.isIdentifier(node.name) && !!statement && ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)) && this.isExported(statement, node.name.text);
    }
    if (ts.isEnumMember(node)) return this.isEntityDeclaration(p);
    if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) {
      return ts.isClassDeclaration(p) && this.isEntityDeclaration(p) && !ts.isComputedPropertyName(node.name ?? (p as any));
    }
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
      return ts.isInterfaceDeclaration(p) && this.isEntityDeclaration(p) && !ts.isComputedPropertyName(node.name);
    }
    if (ts.isParameter(node)) {
      return ts.isConstructorDeclaration(p) && ts.isParameterPropertyDeclaration(node, p) && ts.isIdentifier(node.name) && this.isEntityDeclaration(p.parent);
    }
    return false;
  }

  private isExported(statement: T.Node, name: string): boolean {
    const ts = this.ts;
    const mods = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    const sf = statement.getSourceFile();
    let names = this.localExports.get(sf);
    if (!names) {
      names = new Set();
      for (const s of sf.statements) {
        if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
          for (const e of s.exportClause.elements) names.add((e.propertyName ?? e.name).text);
        }
        if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression)) names.add(s.expression.text);
      }
      this.localExports.set(sf, names);
    }
    return names.has(name);
  }

  memberName(name: T.PropertyName | T.BindingName | undefined): string {
    const ts = this.ts;
    if (!name) return 'default';
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return `[${collapse(name.expression.getText())}]`;
    return collapse((name as T.Node).getText());
  }

  /** Name of a declaration's symbol within its container. */
  declarationName(node: T.Node): string {
    const ts = this.ts;
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (ts.isExportAssignment(node)) return 'default';
    if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && !node.name) return 'default';
    return this.memberName((node as any).name);
  }

  /** The dotted symbol path of a declaration, with the overload suffix when its container has several signatures of it. */
  symbolPath(node: T.Node): string {
    const ts = this.ts;
    const parts: string[] = [];
    let n: T.Node | undefined = node;
    while (n && !ts.isSourceFile(n)) {
      if (ts.isParameter(n)) {
        parts.unshift(this.declarationName(n));
        n = n.parent.parent; // constructor -> class
        continue;
      }
      if (ts.isVariableDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isEnumMember(n) || ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isPropertySignature(n) || ts.isMethodSignature(n) || ts.isExportAssignment(n)) {
        parts.unshift(this.declarationName(n));
      } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
        parts.unshift(n.name.text);
      }
      n = n.parent;
    }
    let path = parts.join('.');
    if (this.isOverloaded(node)) path += `(${this.parameterTypes(node as T.SignatureDeclaration)})`;
    return path;
  }

  private isOverloaded(node: T.Node): boolean {
    const ts = this.ts;
    if (!(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node))) return false;
    const siblings: readonly T.Node[] = ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent) ? (node.parent as T.SourceFile).statements : ((node.parent as any).members ?? []);
    const name = this.declarationName(node);
    const isStatic = this.modifiers(node).includes('static');
    let count = 0;
    for (const s of siblings) {
      if (s.kind === node.kind && this.declarationName(s) === name && this.modifiers(s).includes('static') === isStatic) count++;
    }
    return count > 1;
  }

  parameterTypes(node: T.SignatureDeclaration): string {
    return node.parameters.map((p) => (p.dotDotDotToken ? '...' : '') + (p.type ? collapse(p.type.getText()) : '')).join(',');
  }

  /** Entity id of a declaration node (source or package), or null when it is not an entity. */
  entityIdOf(node: T.Node): string | null {
    if (!this.isEntityDeclaration(node)) return null;
    const moduleId = this.moduleId(node.getSourceFile());
    if (!moduleId) return null;
    return moduleId + this.symbolPath(node);
  }

  kindOf(node: T.Node): string {
    const ts = this.ts;
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isTypeAliasDeclaration(node)) return 'typeAlias';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isEnumMember(node)) return 'enumMember';
    if (ts.isFunctionDeclaration(node)) return 'function';
    if (ts.isModuleDeclaration(node)) return 'namespace';
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'accessor';
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) return 'property';
    if (ts.isVariableDeclaration(node) || ts.isExportAssignment(node)) return 'variable';
    return 'unknown';
  }

  modifiers(node: T.Node): string[] {
    const ts = this.ts;
    const out = new Set<string>();
    const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    const mods = ts.canHaveModifiers(target) ? ts.getModifiers(target) ?? [] : [];
    for (const m of mods) {
      switch (m.kind) {
        case ts.SyntaxKind.StaticKeyword: out.add('static'); break;
        case ts.SyntaxKind.ReadonlyKeyword: out.add('readonly'); break;
        case ts.SyntaxKind.AbstractKeyword: out.add('abstract'); break;
        case ts.SyntaxKind.AsyncKeyword: out.add('async'); break;
        case ts.SyntaxKind.DeclareKeyword: out.add('declare'); break;
        case ts.SyntaxKind.DefaultKeyword: out.add('default'); break;
        case ts.SyntaxKind.OverrideKeyword: out.add('override'); break;
        case ts.SyntaxKind.ConstKeyword: out.add('const'); break;
      }
    }
    if ((node as any).questionToken) out.add('optional');
    if (ts.isVariableDeclaration(node)) {
      const flags = node.parent.flags;
      if (flags & ts.NodeFlags.Const) out.add('const');
      else if (flags & ts.NodeFlags.Let) out.add('let');
      else out.add('var');
    }
    if (ts.isGetAccessorDeclaration(node)) out.add('get');
    if (ts.isSetAccessorDeclaration(node)) out.add('set');
    return [...out];
  }

  accessibility(node: T.Node): string {
    const ts = this.ts;
    const p = node.parent;
    const topLevel = ts.isSourceFile(p) || ts.isModuleBlock(p) || (ts.isVariableDeclaration(node) && (ts.isSourceFile(node.parent.parent.parent) || ts.isModuleBlock(node.parent.parent.parent)));
    if (topLevel) {
      if (ts.isExportAssignment(node)) return 'export';
      const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
      return this.isExported(statement, this.declarationName(node)) ? 'export' : 'module';
    }
    if ((node as any).name && ts.isPrivateIdentifier((node as any).name)) return 'private';
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
    if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
    if (mods.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
    return 'public';
  }

  signatureOf(node: T.Node): string {
    const ts = this.ts;
    const text = (n: T.Node | undefined) => (n ? collapse(n.getText()) : '');
    const typeParams = (n: any) => (n.typeParameters ? `<${n.typeParameters.map((t: T.Node) => text(t)).join(', ')}>` : '');
    const params = (n: T.SignatureDeclaration) => `(${n.parameters.map((p) => text(p).replace(/\s*=.*$/s, '')).join(', ')})`;
    const ret = (n: any) => (n.type ? `: ${text(n.type)}` : '');
    const heritage = (n: T.ClassDeclaration | T.InterfaceDeclaration) => (n.heritageClauses ?? []).map((h) => ' ' + text(h)).join('');
    let s: string;
    if (ts.isClassDeclaration(node)) s = `class ${this.declarationName(node)}${typeParams(node)}${heritage(node)}`;
    else if (ts.isInterfaceDeclaration(node)) s = `interface ${node.name.text}${typeParams(node)}${heritage(node)}`;
    else if (ts.isTypeAliasDeclaration(node)) s = `type ${node.name.text}${typeParams(node)} = ${text(node.type)}`;
    else if (ts.isEnumDeclaration(node)) s = `enum ${node.name.text}`;
    else if (ts.isEnumMember(node)) s = text(node);
    else if (ts.isFunctionDeclaration(node)) s = `function ${this.declarationName(node)}${typeParams(node)}${params(node)}${ret(node)}`;
    else if (ts.isModuleDeclaration(node)) s = `namespace ${text(node.name)}`;
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) s = `${this.declarationName(node)}${(node as any).questionToken ? '?' : ''}${typeParams(node)}${params(node)}${ret(node)}`;
    else if (ts.isConstructorDeclaration(node)) s = `constructor${params(node)}`;
    else if (ts.isGetAccessorDeclaration(node)) s = `get ${this.declarationName(node)}()${ret(node)}`;
    else if (ts.isSetAccessorDeclaration(node)) s = `set ${this.declarationName(node)}${params(node)}`;
    else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) s = `${this.declarationName(node)}${(node as any).questionToken ? '?' : ''}${(node as any).type ? ': ' + text((node as any).type) : ''}`;
    else if (ts.isVariableDeclaration(node)) s = `${this.modifiers(node).find((m) => m === 'const' || m === 'let' || m === 'var')} ${this.declarationName(node)}${node.type ? ': ' + text(node.type) : ''}`;
    else if (ts.isExportAssignment(node)) s = 'export default';
    else s = text(node);
    return s.length > 300 ? s.slice(0, 297) + '...' : s;
  }

  /** Creates the entity record of a declaration node (source or package); returns its id. */
  ensureEntity(node: T.Node): string | null {
    const id = this.entityIdOf(node);
    if (!id) return null;
    if (this.gen.entities.has(id)) return id;
    const ts = this.ts;
    const sf = node.getSourceFile();
    const rel = this.rel(sf.fileName);
    let container: string | null = null;
    let p: T.Node | undefined = ts.isParameter(node) ? node.parent.parent : node.parent;
    while (p && !ts.isSourceFile(p)) {
      if (this.isEntityDeclaration(p)) {
        container = this.ensureEntity(p);
        break;
      }
      p = p.parent;
    }
    if (!container) container = this.moduleId(sf);
    if (container && container.endsWith('#')) this.ensureModuleEntity(sf);
    this.gen.addEntity({
      id,
      kind: this.kindOf(node),
      name: this.declarationName(node),
      container,
      signature: this.signatureOf(node),
      accessibility: this.accessibility(node),
      modifiers: this.modifiers(node),
      origin: rel ? 'source' : 'metadata',
      project: rel ? this.projectPathOf(rel) : null,
      ext: { ts: { module: rel ? stripExtension(rel) : stripExtension(sf.fileName.slice((packageOf(sf.fileName)?.root.length ?? 0) + 1)) } },
    });
    return id;
  }

  ensureModuleEntity(sf: T.SourceFile): string | null {
    const id = this.moduleId(sf);
    if (!id) return null;
    if (!this.gen.entities.has(id)) {
      const rel = this.rel(sf.fileName);
      const pkg = rel ? null : packageOf(sf.fileName);
      const modulePath = rel ? stripExtension(rel) : stripExtension(sf.fileName.replace(/\\/g, '/').slice(pkg!.root.length + 1));
      this.gen.addEntity({
        id,
        kind: 'module',
        name: posix.basename(modulePath),
        container: null,
        signature: rel ?? `${pkg!.name}/${modulePath}`,
        accessibility: 'export',
        modifiers: [],
        origin: rel ? 'source' : 'metadata',
        project: rel ? this.projectPathOf(rel) : null,
        ext: { ts: { module: rel ? modulePath : `${pkg!.name}/${modulePath}`, ...(pkg ? { package: pkg.name, version: pkg.version } : {}) } },
      });
    }
    return id;
  }

  // ---------- symbols ----------

  resolveAlias(symbol: T.Symbol | undefined): T.Symbol | undefined {
    if (!symbol || !this.checker) return symbol;
    if (symbol.flags & this.ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  }

  /** Entity id of a symbol: its first entity declaration in (file, position) order. */
  entityOfSymbol(symbol: T.Symbol | undefined): string | null {
    const s = this.resolveAlias(symbol);
    if (!s) return null;
    const decls = [...(s.declarations ?? [])].sort((a, b) => compareOrdinal(a.getSourceFile().fileName, b.getSourceFile().fileName) || a.pos - b.pos);
    for (const d of decls) {
      if (this.ts.isSourceFile(d)) return this.ensureModuleEntity(d);
      const id = this.ensureEntity(this.entityNodeOf(d));
      if (id) return id;
    }
    return null;
  }

  /** Arrow functions and function expressions stand for the property or variable they initialize. */
  entityNodeOf(decl: T.Node): T.Node {
    const ts = this.ts;
    if ((ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && decl.parent && (ts.isPropertyDeclaration(decl.parent) || ts.isVariableDeclaration(decl.parent))) {
      return decl.parent;
    }
    return decl;
  }

  symbolAt(node: T.Node): T.Symbol | undefined {
    if (!this.checker) return undefined;
    try {
      if (this.ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
        return this.checker.getShorthandAssignmentValueSymbol(node.parent);
      }
      return this.checker.getSymbolAtLocation(node);
    } catch {
      return undefined;
    }
  }

  /** Declared target of a call, new or decorator expression (overload-specific), or null. */
  callTarget(call: T.CallLikeExpression): string | null {
    const ts = this.ts;
    if (!this.checker) return null;
    let signature: T.Signature | undefined;
    try {
      signature = this.checker.getResolvedSignature(call);
    } catch {
      signature = undefined;
    }
    const decl = signature?.declaration;
    if (decl && !ts.isJSDocSignature(decl)) {
      const id = this.ensureEntity(this.entityNodeOf(decl));
      if (id) return id;
    }
    // `new X()` without a declared constructor, or a call through a property typed with a function type.
    const expr = ts.isDecorator(call) ? call.expression : ts.isTaggedTemplateExpression(call) ? call.tag : (call as T.CallExpression | T.NewExpression).expression;
    if (ts.isNewExpression(call) || ts.isPropertyAccessExpression(expr) || ts.isIdentifier(expr)) {
      const name = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
      return this.entityOfSymbol(this.symbolAt(name));
    }
    return null;
  }

  /** The innermost entity that contains a node (code in lambdas and locals is attributed to its container, D6). */
  containerOf(node: T.Node): string | null {
    const ts = this.ts;
    let p: T.Node | undefined = node.parent;
    let child: T.Node = node;
    while (p) {
      if (ts.isSourceFile(p)) return this.ensureModuleEntity(p);
      if (this.isEntityDeclaration(p) && !(ts.isParameter(p) && child === (p as T.ParameterDeclaration).name)) return this.ensureEntity(p);
      child = p;
      p = p.parent;
    }
    return null;
  }

  // ---------- extraction ----------

  extractFile(sf: T.SourceFile): void {
    const rel = this.rel(sf.fileName)!;
    const moduleId = this.ensureModuleEntity(sf)!;
    const fileSpan = this.span(sf, 0, sf.getEnd());
    this.gen.addDeclaration(moduleId, this.contextId, rel, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, fileSpan);
    const ts = this.ts;
    const visit = (node: T.Node): void => {
      if (this.isEntityDeclaration(node)) this.declareNode(node);
      if (this.checker) this.semanticNode(node);
      else this.syntaxNode(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  private nameNode(node: T.Node): T.Node {
    const ts = this.ts;
    if (ts.isConstructorDeclaration(node)) return node.getChildren().find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword) ?? node;
    if (ts.isExportAssignment(node)) return node.getChildren().find((c) => c.kind === ts.SyntaxKind.DefaultKeyword) ?? node;
    const name = (node as any).name as T.Node | undefined;
    if (name) return name;
    return node.getChildren().find((c) => c.kind === ts.SyntaxKind.ClassKeyword || c.kind === ts.SyntaxKind.FunctionKeyword) ?? node;
  }

  private declareNode(node: T.Node): void {
    const id = this.ensureEntity(node);
    if (!id) return;
    const sf = node.getSourceFile();
    const rel = this.rel(sf.fileName)!;
    const nameNode = this.nameNode(node);
    const extentNode = this.ts.isVariableDeclaration(node) ? node.parent.parent : node;
    this.gen.addDeclaration(id, this.contextId, rel, this.nodeSpan(nameNode), this.span(sf, extentNode.getStart(sf), extentNode.getEnd()));
    const container = this.gen.entities.get(id)!.container as string | null;
    const ev = this.evidence(nameNode);
    if (container && ev) this.gen.addRelation('contains', container, id, this.contextId, 'exact', [ev]);
    if (this.ts.isClassDeclaration(node) || this.ts.isInterfaceDeclaration(node)) this.heritage(node, id);
    if (this.checker && (this.ts.isMethodDeclaration(node) || this.ts.isPropertyDeclaration(node) || this.ts.isGetAccessorDeclaration(node) || this.ts.isSetAccessorDeclaration(node) || this.ts.isParameter(node))) {
      this.memberRelations(node, id, nameNode);
    }
  }

  private heritage(node: T.ClassDeclaration | T.InterfaceDeclaration, id: string): void {
    const ts = this.ts;
    for (const clause of node.heritageClauses ?? []) {
      const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'inherits';
      for (const type of clause.types) {
        const target = this.checker ? this.entityOfSymbol(this.symbolAt(type.expression)) : this.syntaxResolve(type.expression);
        const ev = this.evidence(type);
        if (target && ev) this.gen.addRelation(kind, id, target, this.contextId, 'exact', [ev]);
      }
    }
  }

  /** overrides (base class member) and implements (interface member) by name, through the checker. */
  private memberRelations(node: T.Node, id: string, nameNode: T.Node): void {
    const ts = this.ts;
    const checker = this.checker!;
    const cls = (ts.isParameter(node) ? node.parent.parent : node.parent) as T.ClassDeclaration;
    if (!ts.isClassDeclaration(cls)) return;
    if (this.modifiers(node).includes('static')) return;
    const name = this.declarationName(node);
    const ev = this.evidence(nameNode);
    if (!ev) return;
    const classType = checker.getTypeAtLocation(cls) as T.InterfaceType;
    const memberOf = (type: T.Type): string | null => {
      const prop = type.getProperty(name);
      return prop ? this.entityOfSymbol(prop) : null;
    };
    // Base class chain: the nearest base member is overridden.
    let base: T.Type[] = [];
    try {
      base = checker.getBaseTypes(classType) as T.Type[];
    } catch {
      base = [];
    }
    for (const b of base) {
      const target = memberOf(b);
      if (target && target !== id) {
        this.gen.addRelation('overrides', id, target, this.contextId, 'exact', [ev]);
        break;
      }
    }
    // Implemented interfaces (and the interfaces they extend).
    for (const clause of cls.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const t of clause.types) {
        const seen = new Set<T.Type>();
        const queue: T.Type[] = [checker.getTypeAtLocation(t)];
        while (queue.length > 0) {
          const type = queue.shift()!;
          if (seen.has(type)) continue;
          seen.add(type);
          const own = type.getSymbol()?.members?.get(name as T.__String);
          if (own) {
            const target = this.entityOfSymbol(own);
            if (target && target !== id) this.gen.addRelation('implements', id, target, this.contextId, 'exact', [ev]);
          }
          if (type.isClassOrInterface()) {
            try {
              queue.push(...(checker.getBaseTypes(type as T.InterfaceType) as T.Type[]));
            } catch {
              // base types of an unresolved type
            }
          }
        }
      }
    }
  }

  private usageOf(node: T.Identifier | T.PrivateIdentifier): string {
    const ts = this.ts;
    let n: T.Node = node;
    // Climb property accesses where this identifier is the accessed name.
    while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
    const p = n.parent;
    if (!p) return 'other';
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isImportEqualsDeclaration(p)) return 'import';
    for (let d: T.Node | undefined = n; d; d = d.parent) {
      if (ts.isDecorator(d)) return 'decorator';
      if (ts.isStatement(d) || ts.isClassElement(d)) break;
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) return 'invocation';
    if (ts.isTaggedTemplateExpression(p) && p.tag === n) return 'invocation';
    if (ts.isTypeQueryNode(p)) return 'typeof';
    if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return 'write';
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return 'write';
    for (let d: T.Node | undefined = n; d && !ts.isStatement(d); d = d.parent) {
      if (ts.isTypeNode(d) || ts.isHeritageClause(d)) return 'other';
    }
    return 'read';
  }

  private isOwnDeclarationName(node: T.Node): boolean {
    const p = node.parent as any;
    return !!p && p.name === node && this.isEntityDeclaration(p);
  }

  private semanticNode(node: T.Node): void {
    const ts = this.ts;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (this.isOwnDeclarationName(node)) return;
      const p = node.parent;
      if (p && ts.isImportSpecifier(p) && p.propertyName === node) return;
      if (p && ts.isExportSpecifier(p) && p.propertyName === node) return;
      const target = this.entityOfSymbol(this.symbolAt(node));
      if (!target) return;
      const from = this.containerOf(node);
      if (!from || from === target) return;
      const ev = this.evidence(node);
      if (ev) this.gen.addRelation('references', from, target, this.contextId, 'exact', [ev], { usage: this.usageOf(node) });
      return;
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      this.moduleReference(node, node.moduleSpecifier);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      this.moduleReference(node, node.arguments[0]);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isDecorator(node) || ts.isTaggedTemplateExpression(node)) {
      if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) return; // the inner call carries it
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
      const target = this.callTarget(node as T.CallLikeExpression);
      if (!target) return;
      const from = this.containerOf(node);
      if (!from) return;
      const anchor = this.calleeName(node);
      const ev = this.evidence(anchor);
      if (ev) {
        this.gen.addRelation('calls_declared_target', from, target, this.contextId, 'exact', [ev]);
        this.calls.push({ from, to: target, evidence: ev, node });
      }
    }
  }

  /** Module-level dependency: references with usage `import` from the importing module (or container) to the module. */
  private moduleReference(node: T.Node, specifier: T.Expression): void {
    const symbol = this.symbolAt(specifier);
    const decl = symbol?.declarations?.find((d) => this.ts.isSourceFile(d)) as T.SourceFile | undefined;
    if (!decl) return;
    const target = this.ensureModuleEntity(decl);
    const from = this.ts.isCallExpression(node) ? this.containerOf(node) : this.ensureModuleEntity(node.getSourceFile());
    const ev = this.evidence(specifier);
    if (target && from && ev && target !== from) this.gen.addRelation('references', from, target, this.contextId, 'exact', [ev], { usage: 'import' });
  }

  calleeName(node: T.Node): T.Node {
    const ts = this.ts;
    let e: T.Node = ts.isDecorator(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : (node as any).expression ?? node;
    if (ts.isCallExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e)) return e.name;
    if (ts.isElementAccessExpression(e)) return e.argumentExpression;
    return e;
  }

  // ---------- syntax fallback ----------

  private syntaxNode(_node: T.Node): void {
    // The parser-only mode records declarations, containment and heritage (resolved through imports).
  }

  /** Resolves an identifier (or qualified name) through the file's declarations and relative imports. */
  syntaxResolve(expr: T.Node): string | null {
    const ts = this.ts;
    if (!ts.isIdentifier(expr)) return null;
    const sf = expr.getSourceFile();
    const name = expr.text;
    const rel = this.rel(sf.fileName);
    if (!rel) return null;
    for (const s of sf.statements) {
      if ((ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name?.text === name) return this.ensureEntity(s);
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
        for (const el of s.importClause.namedBindings.elements) {
          if (el.name.text !== name) continue;
          const spec = s.moduleSpecifier.text;
          if (!spec.startsWith('.')) return null;
          const base = posix.normalize(posix.join(posix.dirname(rel), spec));
          for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
            if (this.gen.hasBlob(candidate)) {
              const target = `ts:${this.projectPathOf(candidate)}:${stripExtension(candidate)}#${(el.propertyName ?? el.name).text}`;
              return target;
            }
          }
          return null;
        }
      }
    }
    return null;
  }

  /** Evidence with an explicit file and span (templates, configuration files). */
  evidenceAt(path: string, span: Span, method: Method = this.method): string {
    return this.gen.addEvidence(path, span, method, this.contextId);
  }

  observe(kind: string, fields: Record<string, unknown>, evidence: (string | null)[]): string | null {
    const ev = evidence.filter((e): e is string => !!e);
    if (ev.length === 0) return null;
    return this.gen.observe(kind, this.project.path, this.contextId, fields, ev);
  }

  relation(kind: string, from: string, to: string, resolution: Resolution, evidence: string[], extra: Record<string, unknown> = {}): void {
    this.gen.addRelation(kind, from, to, this.contextId, resolution, evidence, extra);
  }

  fileText(path: string): string {
    return readFileSync(join(this.workRoot, path), 'utf8');
  }

  absolute(rel: string): string {
    return join(this.workRoot, rel);
  }

  dirOf(rel: string): string {
    return dirname(rel);
  }
}
