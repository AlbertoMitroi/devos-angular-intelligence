// index.sqlite (PLAN Step 4): tables mirror the contract records, indexes in both directions, FTS5 over names,
// signatures and snippets. Derived data; the NDJSON graph stays the source of truth. A canonical dump (sorted rows)
// is what must be identical across runs and architectures.
import { DatabaseSync } from 'node:sqlite';
import type { RecordSet, Rec } from './integrity.ts';
import { canonical } from '../util/canonical.ts';

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

const SCHEMA = `
create table meta(key text primary key, value text not null);
create table entities(id text primary key, kind text, name text, container text, signature text, project text, origin text, json text);
create table declarations(id text primary key, entity text, context text, path text, line integer, col integer);
create table evidence(id text primary key, path text, line integer, col integer, end_line integer, end_col integer, method text, context text, text text);
create table relations(id text primary key, kind text, from_id text, to_id text, usage text, resolution text, context text, path text, line integer, declared_target text);
create table observations(id text primary key, kind text, project text, path text, line integer, json text);
create table links(id text primary key, kind text, via text, from_obs text, to_obs text, resolution text, reason text);
create table diagnostics(id text primary key, severity text, code text, scope text, state text, message text);
create table projects(id text primary key, record_type text, path text, json text);
create index relations_from on relations(from_id, kind);
create index relations_to on relations(to_id, kind);
create index declarations_entity on declarations(entity);
create index declarations_location on declarations(path, line);
create index entities_name on entities(name);
create index observations_kind on observations(kind);
create index links_from on links(from_obs);
create index links_to on links(to_obs);
create virtual table search using fts5(ref unindexed, kind unindexed, text);
`;

export function writeIndex(path: string, set: RecordSet, meta: Record<string, string>): void {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = off; pragma synchronous = off;');
  db.exec(SCHEMA);
  db.exec('begin');
  const evidence = new Map<string, Rec>(set.evidence.map((e) => [e.id, e]));
  const snippets = new Map<string, Rec>(set.snippets.map((s) => [s.id, s]));
  const firstEvidence = (ids: unknown) => evidence.get((ids as string[])[0]);
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
    const e = firstEvidence(r.evidence);
    const span = e?.span as { startLine: number } | undefined;
    rel.run(r.id, r.kind as string, r.from as string, r.to as string, (r.usage as string) ?? null, r.resolution as string, r.context as string, (e?.path as string) ?? null, span?.startLine ?? null, (r.declaredTarget as string) ?? null);
  }
  const obs = db.prepare('insert into observations values (?, ?, ?, ?, ?, ?)');
  for (const o of set.observations) {
    const e = firstEvidence(o.evidence);
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
