// index.sqlite (PLAN Step 4, contract v1.2 index schema 1): the base tables of the vendored index.sql exactly as
// written, FTS5 over names, signatures and snippets. Derived data; the NDJSON graph stays the source of truth. A canonical dump (sorted rows)
// is what must be identical across runs and architectures.
import { DatabaseSync } from 'node:sqlite';
import type { RecordSet, Rec } from './integrity.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, compareOrdinal } from '../util/canonical.ts';
import { SCHEMA_DIR } from './schema.ts';

export function sqliteInfo(): { version: string; fts5: boolean } {
  const db = new DatabaseSync(':memory:');
  const version = String((db.prepare('select sqlite_version() as v').get() as { v: string }).v);
  let fts5 = true;
  try {
    db.exec('create virtual table t using fts5(x)');
  } catch {
    fts5 = false;
  }
  db.close();
  return { version, fts5 };
}

/** The "base" section of the vendored contract index schema (schema/index/v1/index.sql, index schema 1), as written. */
function baseSchema(): string {
  const sql = readFileSync(join(SCHEMA_DIR, '..', 'index', 'v1', 'index.sql'), 'utf8');
  const out: string[] = [];
  let section = '';
  for (const line of sql.split('\n')) {
    const header = /^--\s*(base|evidence|system)\s*$/.exec(line.trim());
    if (header) section = header[1];
    else if (section === 'base' && line.trim() && !line.trim().startsWith('--')) out.push(line);
  }
  return out.join('\n');
}

type Span = { startLine: number; startColumn: number };

/** Index schema 1: the first evidence by (path ordinal, startLine, startColumn). */
function firstByLocation(evidence: Map<string, Rec>, ids: string[]): Rec | undefined {
  let best: Rec | undefined;
  for (const id of ids) {
    const e = evidence.get(id);
    if (!e) continue;
    if (!best) {
      best = e;
      continue;
    }
    const a = e.span as Span;
    const b = best.span as Span;
    const c = compareOrdinal(e.path as string, best.path as string) || a.startLine - b.startLine || a.startColumn - b.startColumn;
    if (c < 0) best = e;
  }
  return best;
}

export function writeIndex(path: string, set: RecordSet, meta: Record<string, string>): void {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = off; pragma synchronous = off;');
  db.exec(baseSchema());
  db.exec('begin');
  const evidence = new Map<string, Rec>(set.evidence.map((e) => [e.id, e]));
  const snippets = new Map<string, Rec>(set.snippets.map((s) => [s.id, s]));
  const insertMeta = db.prepare('insert into meta values (?, ?)');
  for (const [k, v] of Object.entries(meta).sort()) insertMeta.run(k, v);
  const ent = db.prepare('insert into entities values (?, ?, ?, ?, ?, ?, ?, ?)');
  const search = db.prepare('insert into search values (?, ?, ?)');
  for (const e of set.entities) {
    ent.run(e.id, e.kind as string, e.name as string, (e.container as string) ?? null, e.signature as string, (e.project as string) ?? null, e.origin as string, canonical(e));
    search.run(e.id, 'entity', `${e.name} ${e.signature} ${e.kind}`);
  }
  const decl = db.prepare('insert into declarations values (?, ?, ?, ?, ?, ?)');
  for (const d of set.declarations) {
    const span = d.span as { startLine: number; startColumn: number };
    decl.run(d.id, d.entity as string, d.context as string, d.path as string, span.startLine, span.startColumn);
  }
  const ev = db.prepare('insert into evidence values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of set.evidence) {
    const span = e.span as { startLine: number; startColumn: number; endLine: number; endColumn: number };
    const text = e.snippet ? (snippets.get(e.snippet as string)?.text as string) ?? null : null;
    ev.run(e.id, e.path as string, span.startLine, span.startColumn, span.endLine, span.endColumn, e.method as string, e.context as string, text);
  }
  for (const s of set.snippets) search.run(s.id, 'snippet', s.text as string);
  const rel = db.prepare('insert into relations values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of set.relations) {
    const e = firstByLocation(evidence, r.evidence as string[]);
    const span = e?.span as { startLine: number } | undefined;
    rel.run(r.id, r.kind as string, r.from as string, r.to as string, (r.usage as string) ?? null, r.resolution as string, r.context as string, (e?.path as string) ?? null, span?.startLine ?? null, (r.declaredTarget as string) ?? null);
  }
  const obs = db.prepare('insert into observations values (?, ?, ?, ?, ?, ?)');
  for (const o of set.observations) {
    // The site (v1.2), else the first evidence by location.
    const e = (typeof o.site === 'string' ? evidence.get(o.site) : undefined) ?? firstByLocation(evidence, o.evidence as string[]);
    const span = e?.span as { startLine: number } | undefined;
    obs.run(o.id, o.kind as string, o.project as string, (e?.path as string) ?? null, span?.startLine ?? null, canonical(o));
  }
  const lnk = db.prepare('insert into links values (?, ?, ?, ?, ?, ?, ?)');
  for (const l of set.links) {
    lnk.run(l.id, l.kind as string, l.via as string, (l.from as Rec).observation as string, l.to ? ((l.to as Rec).observation as string) : null, l.resolution as string, (l.reason as string) ?? null);
  }
  const diag = db.prepare('insert into diagnostics values (?, ?, ?, ?, ?, ?)');
  for (const d of set.diagnostics) diag.run(d.id, d.severity as string, d.code as string, d.scope as string, d.state as string, d.message as string);
  const prj = db.prepare('insert into projects values (?, ?, ?, ?)');
  for (const p of set.projects) prj.run(p.id, p.recordType as string, p.path as string ?? p.project as string, canonical(p));
  db.exec('commit');
  db.close();
}

/** Canonical dump: every table, rows sorted, one JSON array per line. */
export function dumpIndex(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'search_%' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((t) => t.name);
  const lines: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`select * from "${t}"`).all() as Record<string, unknown>[];
    const encoded = rows.map((r) => canonical(Object.values(r).map((v) => (typeof v === 'bigint' ? Number(v) : v)))).sort();
    for (const row of encoded) lines.push(`${t}\t${row}`);
  }
  db.close();
  return lines.join('\n') + '\n';
}
