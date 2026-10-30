// The in-memory generation: every record of contract v1.1 with its content-hash id.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordId, compareOrdinal } from './util/canonical.ts';
import { redactLine } from './secrets.ts';

export const ENGINE_NAME = 'angular-intelligence';
export const ENGINE_VERSION = '0.2.0';
export const EXTRACTOR = `${ENGINE_NAME}@${ENGINE_VERSION}`;

export interface Span {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type Method = 'semantic' | 'syntax' | 'metadata' | 'config' | 'configured-convention';
export type Resolution = 'exact' | 'ambiguous' | 'candidate' | 'unresolved';
export type DiagnosticState = 'failed' | 'partial' | 'unsupported' | 'unknown';
export type Severity = 'info' | 'warning' | 'error';
export type LoadMode = 'semantic' | 'syntax' | 'failed';

export type Rec = Record<string, unknown> & { id: string };

export interface EntityInput {
  id: string;
  kind: string;
  name: string;
  container: string | null;
  signature: string;
  accessibility: string;
  modifiers: string[];
  origin: 'source' | 'generated' | 'metadata';
  project: string | null;
  ext?: Record<string, unknown>;
}

export class Generation {
  readonly entities = new Map<string, Rec>();
  readonly declarations = new Map<string, Rec>();
  readonly relations = new Map<string, Rec>();
  readonly evidence = new Map<string, Rec>();
  readonly observations = new Map<string, Rec>();
  readonly links = new Map<string, Rec>();
  readonly diagnostics = new Map<string, Rec>();
  readonly snippets = new Map<string, Rec>();
  readonly projects = new Map<string, Rec>();
  readonly contexts = new Map<string, Rec>();
  private readonly lineCache = new Map<string, string[]>();

  readonly workRoot: string;
  readonly blobs: Map<string, string>;

  constructor(workRoot: string, blobs: Map<string, string>) {
    this.workRoot = workRoot;
    this.blobs = blobs;
  }

  blobId(path: string): string {
    const blob = this.blobs.get(path);
    if (!blob) throw new Error(`no blob id for '${path}'`);
    return blob;
  }

  hasBlob(path: string): boolean {
    return this.blobs.has(path);
  }

  lines(path: string): string[] {
    let lines = this.lineCache.get(path);
    if (!lines) {
      lines = readFileSync(join(this.workRoot, path), 'utf8').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
      this.lineCache.set(path, lines);
    }
    return lines;
  }

  addEntity(input: EntityInput): string {
    if (!this.entities.has(input.id)) {
      const record: Rec = {
        id: input.id,
        kind: input.kind,
        name: input.name,
        container: input.container,
        signature: input.signature,
        accessibility: input.accessibility,
        modifiers: [...input.modifiers].sort(compareOrdinal),
        origin: input.origin,
        documentationId: null,
        project: input.project,
        assembly: null,
        namespace: null,
      };
      if (input.ext) record.ext = input.ext;
      this.entities.set(input.id, record);
    }
    return input.id;
  }

  addDeclaration(entity: string, context: string, path: string, span: Span, extent: Span): string {
    const id = recordId('decl', { entity, context, path, span });
    if (!this.declarations.has(id)) {
      this.declarations.set(id, { id, entity, context, path, blobId: this.blobId(path), span, extent, store: 'repository' });
    }
    return id;
  }

  addEvidence(path: string, span: Span, method: Method, context: string): string {
    const blobId = this.blobId(path);
    const id = recordId('ev', { path, blobId, span, extractor: EXTRACTOR, method, context });
    if (!this.evidence.has(id)) {
      const snippet = this.addSnippet(path, blobId, span.startLine);
      const record: Rec = { id, path, blobId, span, extractor: EXTRACTOR, method, context, store: 'repository' };
      if (snippet) record.snippet = snippet;
      this.evidence.set(id, record);
    }
    return id;
  }

  private addSnippet(path: string, blobId: string, line: number): string | null {
    const lines = this.lines(path);
    if (line < 1 || line > lines.length) return null;
    const id = recordId('snip', { blobId, line });
    if (!this.snippets.has(id)) {
      const text = redactLine(lines[line - 1]);
      this.snippets.set(id, { id, blobId, line, text: text.length > 400 ? text.slice(0, 400) : text });
    }
    return id;
  }

  addRelation(kind: string, from: string, to: string, context: string, resolution: Resolution, evidence: string[], extra: Record<string, unknown> = {}): string {
    const id = recordId('rel', { kind, from, to, context, evidence, ...extra });
    if (!this.relations.has(id)) {
      this.relations.set(id, { id, kind, from, to, context, resolution, evidence: [...new Set(evidence)].sort(compareOrdinal), ...extra });
    }
    return id;
  }

  /** The first evidence is the `site` of the fact (contract v1.2: the call, the registration, the declaration name, ...). */
  observe(kind: string, project: string, context: string, fields: Record<string, unknown>, evidence: string[]): string {
    const sorted = [...new Set(evidence)].sort(compareOrdinal);
    const site = evidence[0];
    const id = recordId('obs', { kind, project, context, fields, site, evidence: sorted });
    if (!this.observations.has(id)) {
      this.observations.set(id, { id, kind, project, context, ...fields, site, evidence: sorted });
    }
    return id;
  }

  diagnostic(severity: Severity, code: string, scope: string, state: DiagnosticState, message: string, ext?: Record<string, unknown>): string {
    const id = recordId('diag', { code, scope, state, message });
    if (!this.diagnostics.has(id)) {
      const record: Rec = { id, severity, code, scope, state, message };
      if (ext) record.ext = ext;
      this.diagnostics.set(id, record);
    }
    return id;
  }

  addLink(kind: string, via: string, from: Rec, to: Rec | null, resolution: Resolution, evidence: string[], reason?: string, ext?: Record<string, unknown>): string {
    const fromRef = { observation: from.id, kind: from.kind, project: from.project };
    const toRef = to ? { observation: to.id, kind: to.kind, project: to.project } : null;
    const id = recordId('lnk', { kind, via, from: fromRef, to: toRef });
    const record: Rec = { id, kind, via, from: fromRef, to: toRef, resolution, evidence: [...new Set(evidence)].sort(compareOrdinal) };
    if (reason) record.reason = reason;
    if (ext) record.ext = ext;
    this.links.set(id, record);
    return id;
  }
}

/** Sorted records of a map, by id (ordinal). */
export function sortedRecords(map: Map<string, Rec>): Rec[] {
  return [...map.values()].sort((a, b) => compareOrdinal(a.id, b.id));
}
