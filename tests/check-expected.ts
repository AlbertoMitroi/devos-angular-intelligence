// Compares one generation with the fixture's hand-written expected.yml (full precision and recall per declared kind).
// Usage: node tests/check-expected.ts <expected.yml> <generation-dir> <exit-code> [<events.ndjson>]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type Rec = Record<string, any>;

function read(dir: string, file: string): Rec[] {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

function sets(failures: string[], what: string, expected: Iterable<string>, actual: Iterable<string>): void {
  const e = new Set(expected);
  const a = new Set(actual);
  for (const x of [...e].filter((x) => !a.has(x)).sort()) failures.push(`${what}: missing ${x}`);
  for (const x of [...a].filter((x) => !e.has(x)).sort()) failures.push(`${what}: unexpected ${x}`);
}

function subsetEqual(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return JSON.stringify(expected) === JSON.stringify(actual ?? null);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => subsetEqual(v, actual[i]));
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected as Rec).every(([k, v]) => subsetEqual(v, (actual as Rec)[k]));
}

export function compare(expected: Rec, dir: string, exitCode: number): string[] {
  const failures: string[] = [];
  if (expected.exitCode !== undefined && expected.exitCode !== exitCode) failures.push(`exit code ${exitCode}, expected ${expected.exitCode}`);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  if (expected.status !== undefined && manifest?.status !== expected.status) failures.push(`status ${manifest?.status}, expected ${expected.status}`);
  if (!manifest) return failures;
  const evidence = new Map(read(dir, 'graph/evidence.ndjson').map((e) => [e.id, e]));
  const at = (ids: string[]) => [...new Set(ids.map((id) => evidence.get(id)).filter((e): e is Rec => !!e).map((e) => `${e.path}:${e.span.startLine}`))].sort().join(',');
  const contexts = read(dir, 'graph/projects.ndjson').filter((p) => p.recordType === 'analysisContext');
  if (expected.loadModes) {
    sets(failures, 'load modes', Object.entries(expected.loadModes).map(([k, v]) => `${k}=${v}`), contexts.map((c) => `${c.project}=${c.loadMode}`));
  }
  for (const [project, fields] of Object.entries<Rec>(expected.toolchain ?? {})) {
    const c = contexts.find((x) => x.project === project);
    if (!c || !subsetEqual(fields, c.ext?.typescript)) failures.push(`toolchain of ${project}: expected ${JSON.stringify(fields)}, got ${JSON.stringify(c?.ext?.typescript)}`);
  }
  const diagnostics = read(dir, 'graph/diagnostics.ndjson');
  if (expected.diagnostics) {
    sets(failures, 'diagnostics', (expected.diagnostics as string[]), diagnostics.map((d) => `${d.code}@${d.scope}`));
  }
  const entities = new Set(read(dir, 'graph/entities.ndjson').map((e) => e.id));
  for (const id of expected.entities ?? []) if (!entities.has(id)) failures.push(`entity missing: ${id}`);
  for (const id of expected.absent ?? []) if (entities.has(id)) failures.push(`entity should be absent: ${id}`);
  if (expected.sourceEntities) {
    const actual = read(dir, 'graph/entities.ndjson').filter((e) => e.origin === 'source').map((e) => `${e.kind} ${e.id}`);
    sets(failures, 'source entities', expected.sourceEntities, actual);
  }
  const declarations = read(dir, 'graph/declarations.ndjson');
  for (const d of expected.declarations ?? []) {
    sets(failures, `declarations of ${d.entity}`, d.at, declarations.filter((x) => x.entity === d.entity).map((x) => `${x.path}:${x.span.startLine}`));
  }
  const relations = read(dir, 'graph/relations.ndjson');
  for (const group of expected.relations ?? []) {
    const kinds = new Set<string>(group.kinds);
    const actual = relations
      .filter((r) => kinds.has(r.kind) && (!group.from || String(r.from).startsWith(group.from)) && (!group.to || String(r.to).startsWith(group.to)) && (!group.usage || group.usage.includes(r.usage)))
      .map((r) => `${r.kind}${r.usage ? ' ' + r.usage : ''} ${r.from} -> ${r.to} @${at(r.evidence)}`);
    sets(failures, `relations ${[...kinds].join('/')}${group.from ? ` from ${group.from}` : ''}${group.to ? ` to ${group.to}` : ''}`, group.items ?? [], actual);
  }
  const observations = read(dir, 'graph/observations.ndjson');
  const byId = new Map(observations.map((o) => [o.id, o]));
  for (const group of [].concat(expected.observations ?? [])) {
    const g = group as Rec;
    const kinds = new Set<string>(g.kinds);
    const remaining = observations.filter((o) => kinds.has(o.kind));
    for (const item of g.items ?? []) {
      const { at: where, ...fields } = item;
      const i = remaining.findIndex((o) => subsetEqual(fields, o) && (where === undefined || at(o.evidence) === where));
      if (i < 0) {
        const near = remaining.filter((o) => o.kind === fields.kind && (where === undefined || at(o.evidence) === where));
        failures.push(`observation missing: ${JSON.stringify(item)}${near.length ? `\n    nearest at same place: ${JSON.stringify(near[0], (k, v) => (k === 'evidence' || k === 'id' ? undefined : v))}` : ''}`);
      } else remaining.splice(i, 1);
    }
    for (const o of remaining) failures.push(`observation unexpected: ${o.kind} @${at(o.evidence)} ${JSON.stringify(o, (k, v) => (k === 'evidence' || k === 'id' ? undefined : v))}`);
  }
  if (expected.links) {
    const links = read(dir, 'graph/links.ndjson').map((l) => {
      const from = byId.get(l.from.observation);
      const to = l.to ? byId.get(l.to.observation) : null;
      return `${l.via} ${l.kind} ${l.resolution} ${from ? at(from.evidence) : '?'} -> ${to ? at(to.evidence) : 'null'}`;
    });
    sets(failures, 'links', expected.links, links);
  }
  for (const secret of expected.secretsAbsent ?? []) {
    for (const f of walk(dir)) {
      if (f.endsWith('.sqlite')) {
        if (readFileSync(f).includes(Buffer.from(secret))) failures.push(`secret '${secret.slice(0, 4)}...' found in ${f}`);
      } else if (readFileSync(f, 'utf8').includes(secret)) failures.push(`secret '${secret.slice(0, 4)}...' found in ${f}`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const [expectedPath, dir, code] = process.argv.slice(2);
  const expected = parse(readFileSync(expectedPath, 'utf8')) as Rec;
  const failures = compare(expected, dir, Number(code));
  if (failures.length > 0) {
    process.stdout.write(failures.map((f) => `  FAIL ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('  expected.yml: all items match\n');
}
