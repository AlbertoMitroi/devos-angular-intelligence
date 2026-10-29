// Environment files (PLAN 1, 3.3): `src/environments/*.ts` and angular.json file replacements per configuration.
// Values are read with the parser only; they are stored nowhere except as destinations (D20) when not secret.
import type * as T from 'typescript';
import engineTs from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo } from '../discovery.ts';
import { joinRepo } from '../discovery.ts';
import { isSecret } from '../secrets.ts';
import type { Span } from '../model.ts';
import { compareOrdinal } from '../util/canonical.ts';

export interface EnvEntry {
  /** `{exported variable}.{property path}`, for example `environment.apis.default.url`. */
  key: string;
  /** Literal value, or null when the value is not a literal (never stored when secret). */
  value: string | null;
  secret: boolean;
  span: Span;
}

export interface EnvFile {
  path: string;
  entries: Map<string, EnvEntry>;
}

export interface AppEnvironment {
  project: ProjectInfo;
  defaultFile: string;
  configurations: { configuration: string; file: string }[];
}

export class EnvRegistry {
  readonly files = new Map<string, EnvFile>();
  readonly apps: AppEnvironment[] = [];

  private readonly workRoot: string;

  constructor(workRoot: string, projects: ProjectInfo[], paths: string[]) {
    this.workRoot = workRoot;
    const known = new Set(paths);
    for (const project of projects) {
      const candidates = new Set<string>();
      for (const r of project.fileReplacements) {
        candidates.add(r.replace);
        candidates.add(r.with);
      }
      const envDir = joinRepo(project.sourceRoot ?? joinRepo(project.path, 'src'), 'environments');
      for (const p of paths) {
        if (p.startsWith(envDir + '/') && /\.ts$/.test(p) && !p.endsWith('.spec.ts') && !p.slice(envDir.length + 1).includes('/')) candidates.add(p);
      }
      for (const c of [...candidates].sort(compareOrdinal)) if (known.has(c) && !this.files.has(c)) this.files.set(c, this.parse(c));
      const replaced = project.fileReplacements.find((r) => known.has(r.replace))?.replace;
      const conventional = joinRepo(envDir, 'environment.ts');
      const defaultFile = replaced ?? (known.has(conventional) ? conventional : null);
      if (defaultFile && project.projectType !== 'library') {
        this.apps.push({
          project,
          defaultFile,
          configurations: project.fileReplacements
            .filter((r) => r.replace === defaultFile && known.has(r.with))
            .map((r) => ({ configuration: r.configuration, file: r.with }))
            .sort((a, b) => compareOrdinal(a.configuration, b.configuration)),
        });
      }
    }
  }

  isEnvironmentFile(path: string): boolean {
    return this.files.has(path);
  }

  private parse(path: string): EnvFile {
    const text = readFileSync(join(this.workRoot, path), 'utf8');
    const ts = engineTs;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const entries = new Map<string, EnvEntry>();
    const locals = new Map<string, T.Expression>();
    for (const s of sf.statements) {
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
    }
    const unwrap = (e: T.Expression): T.Expression => {
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
      return e;
    };
    const literal = (e: T.Expression, depth = 0): string | null => {
      const u = unwrap(e);
      if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
      if (ts.isNumericLiteral(u)) return u.text;
      if (u.kind === ts.SyntaxKind.TrueKeyword) return 'true';
      if (u.kind === ts.SyntaxKind.FalseKeyword) return 'false';
      if (ts.isIdentifier(u) && locals.has(u.text) && depth < 4) return literal(locals.get(u.text)!, depth + 1);
      if (ts.isTemplateExpression(u) && depth < 4) {
        let out = u.head.text;
        for (const span of u.templateSpans) {
          const v = literal(span.expression, depth + 1);
          if (v === null) return null;
          out += v + span.literal.text;
        }
        return out;
      }
      if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken && depth < 4) {
        const a = literal(u.left, depth + 1);
        const b = literal(u.right, depth + 1);
        return a !== null && b !== null ? a + b : null;
      }
      return null;
    };
    const spanOf = (n: T.Node): Span => {
      const a = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      const b = sf.getLineAndCharacterOfPosition(n.getEnd());
      return { startLine: a.line + 1, startColumn: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
    };
    const walk = (obj: T.ObjectLiteralExpression, prefix: string, depth: number) => {
      for (const p of obj.properties) {
        let name: string | null = null;
        let value: T.Expression | null = null;
        if (ts.isPropertyAssignment(p)) {
          name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
          value = p.initializer;
        } else if (ts.isShorthandPropertyAssignment(p)) {
          name = p.name.text;
          value = p.name;
        }
        if (name === null || value === null) continue;
        const key = `${prefix}.${name}`;
        const u = unwrap(value);
        const resolved = ts.isIdentifier(u) && locals.has(u.text) ? unwrap(locals.get(u.text)!) : u;
        if (ts.isObjectLiteralExpression(resolved) && depth < 8) {
          walk(resolved, key, depth + 1);
          continue;
        }
        const v = literal(value);
        const secret = isSecret(name, v);
        entries.set(key, { key, value: secret ? null : v, secret, span: spanOf(p) });
      }
    };
    for (const s of sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      if (!(ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = unwrap(d.initializer);
        if (ts.isObjectLiteralExpression(init)) walk(init, d.name.text, 0);
      }
    }
    return { path, entries };
  }

  /** Applications that read an environment file as their default (or through a replacement). */
  appsUsing(file: string): AppEnvironment[] {
    return this.apps.filter((a) => a.defaultFile === file || a.configurations.some((c) => c.file === file));
  }

  /**
   * Values of one key per configuration, for the given applications: `{ application, configuration, file, value }`.
   * A secret key or value yields `secret: true` and no value (D20).
   */
  values(apps: AppEnvironment[], fallbackFile: string | null, key: string): { application: string | null; configuration: string; file: string; value: string | null; secret: boolean; found: boolean }[] {
    const out: { application: string | null; configuration: string; file: string; value: string | null; secret: boolean; found: boolean }[] = [];
    const add = (application: string | null, configuration: string, file: string) => {
      const entry = this.files.get(file)?.entries.get(key);
      out.push({ application, configuration, file, value: entry?.value ?? null, secret: entry?.secret ?? false, found: !!entry });
    };
    if (apps.length === 0 && fallbackFile) add(null, 'default', fallbackFile);
    for (const app of apps) {
      add(app.project.path, 'default', app.defaultFile);
      for (const c of app.configurations) add(app.project.path, c.configuration, c.file);
    }
    return out;
  }
}
