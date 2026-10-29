// query <generation> <command>: a small read-only command set over index.sqlite, to validate and demonstrate the
// artifacts. Exit codes: 0 results, 3 ambiguous name (candidates listed, none picked), 4 no results, 2 usage.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dumpIndex } from './sqlite.ts';

type Row = Record<string, any>;

export interface QueryOutput {
  code: number;
  text: string;
  json: unknown;
}

export function query(generation: string, args: string[]): QueryOutput {
  const path = join(generation, 'index.sqlite');
  if (!existsSync(path)) return { code: 2, text: `no index.sqlite in '${generation}'`, json: { error: 'no index' } };
  const [command, ...rest] = args;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--json'));
  if (command === 'dump') return { code: 0, text: dumpIndex(path).trimEnd(), json: null };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];
    const resolve = (term: string | undefined): { id: string | null; out?: QueryOutput } => {
      if (!term) return { id: null, out: { code: 2, text: 'missing symbol', json: null } };
      const exact = all('select id, kind, name, signature from entities where id = ?', term);
      if (exact.length === 1) return { id: exact[0].id };
      const byName = all('select id, kind, name, signature from entities where name = ? order by id', term);
      if (byName.length === 1) return { id: byName[0].id };
      if (byName.length === 0) return { id: null, out: { code: 4, text: `no entity named '${term}'`, json: [] } };
      return { id: null, out: { code: 3, text: [`'${term}' is ambiguous; candidates:`, ...byName.map((r) => `  ${r.id}  (${r.kind}) ${r.signature}`)].join('\n'), json: byName } };
    };
    const list = (rows: Row[], fmt: (r: Row) => string, empty: string): QueryOutput =>
      rows.length === 0 ? { code: 4, text: empty, json: [] } : { code: 0, text: rows.map(fmt).join('\n'), json: rows };
    switch (command) {
      case 'symbol': {
        const r = resolve(positional[0]);
        if (r.out) return r.out;
        const e = all('select * from entities where id = ?', r.id!)[0];
        const decls = all('select path, line from declarations where entity = ? order by path, line', r.id!);
        return { code: 0, text: [`${e.id}`, `  ${e.kind} ${e.signature}`, ...decls.map((d) => `  declared at ${d.path}:${d.line}`)].join('\n'), json: { entity: JSON.parse(e.json), declarations: decls } };
      }
      case 'refs': {
        const r = resolve(positional[0]);
        if (r.out) return r.out;
        const usage = flag('--usage');
        const rows = all(`select r.from_id, r.usage, r.path, r.line, e.text from relations r left join evidence e on e.path = r.path and e.line = r.line and e.context = r.context where r.kind = 'references' and r.to_id = ? ${usage ? 'and r.usage = ?' : ''} group by r.id order by r.path, r.line`, ...(usage ? [r.id!, usage] : [r.id!]));
        return list(rows, (x) => `${x.path}:${x.line}  ${x.usage}  ${x.from_id}\n    ${String(x.text ?? '').trim()}`, `no references to ${r.id}`);
      }
      case 'callers':
      case 'callees': {
        const r = resolve(positional[0]);
        if (r.out) return r.out;
        const depth = Number(flag('--depth') ?? 1);
        const seen = new Set<string>([r.id!]);
        let frontier = [r.id!];
        const rows: Row[] = [];
        for (let d = 1; d <= depth && frontier.length > 0; d++) {
          const next: string[] = [];
          for (const f of frontier) {
            const edges = command === 'callers'
              ? all("select from_id as other, path, line from relations where kind = 'calls_declared_target' and to_id = ? order by from_id, path, line", f)
              : all("select to_id as other, path, line from relations where kind = 'calls_declared_target' and from_id = ? order by to_id, path, line", f);
            for (const e of edges) {
              rows.push({ depth: d, of: f, ...e });
              if (!seen.has(e.other)) {
                seen.add(e.other);
                next.push(e.other);
              }
            }
          }
          frontier = next;
        }
        return list(rows, (x) => `${'  '.repeat(x.depth - 1)}${x.other}  ${x.path}:${x.line}`, `no ${command} of ${r.id}`);
      }
      case 'impl': {
        const r = resolve(positional[0]);
        if (r.out) return r.out;
        const rows = all("select kind, from_id, path, line from relations where kind in ('implements', 'overrides', 'inherits') and to_id = ? order by from_id", r.id!);
        return list(rows, (x) => `${x.kind}  ${x.from_id}  ${x.path}:${x.line}`, `no implementations of ${r.id}`);
      }
      case 'di': {
        const r = resolve(positional[0]);
        if (r.out) return r.out;
        const rows = all("select kind, path, line, json from observations where kind in ('di.registers', 'di.consumes') order by kind, path, line").filter((o) => JSON.parse(o.json).service === r.id);
        return list(rows, (x) => {
          const o = JSON.parse(x.json);
          return x.kind === 'di.registers' ? `registers  scope ${o.lifetime}  impl ${o.implementation ?? o.factory ?? o.existing ?? (o.value ? 'value' : '?')}  ${x.path}:${x.line}` : `consumes   ${o.consumer} via ${o.via}  ${x.path}:${x.line}`;
        }, `no registrations or consumers of ${r.id}`);
      }
      case 'routes': {
        const rows = all("select path, line, json from observations where kind = 'ui.route' order by path, line").map((x) => ({ ...JSON.parse(x.json), at: `${x.path}:${x.line}` }));
        rows.sort((a, b) => String(a.path ?? '~' + a.ext?.angular?.relativePath).localeCompare(String(b.path ?? '~' + b.ext?.angular?.relativePath)));
        return list(rows, (x) => `${x.path ?? `(unreached) ${x.ext?.angular?.relativePath}`}  ${x.component ?? x.loadComponent ?? x.loadChildren ?? (x.redirectTo !== null ? 'redirect ' + x.redirectTo : '')}  ${x.at}`, 'no routes');
      }
      case 'http': {
        const prefix = flag('--route');
        const rows = all("select path, line, json from observations where kind = 'http.call' order by path, line")
          .map((x) => ({ ...JSON.parse(x.json), at: `${x.path}:${x.line}` }))
          .filter((x) => !prefix || (x.canonicalRoute != null && String(x.canonicalRoute).startsWith(prefix)));
        return list(rows, (x) => `${x.method} ${x.canonicalRoute ?? '(unknown route)'}  ${x.resolution}  base ${x.baseAddress?.source ?? 'same-origin'}${x.baseAddress?.key ? ' ' + x.baseAddress.key : ''}  ${x.at}`, 'no HTTP calls');
      }
      case 'search': {
        const text = positional.join(' ');
        if (!text) return { code: 2, text: 'missing search text', json: null };
        const rows = all('select ref, kind, text from search where search match ? order by rank, ref limit 50', text.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(' '));
        return list(rows, (x) => `${x.kind}  ${x.ref}  ${String(x.text).trim().slice(0, 160)}`, `no matches for '${text}'`);
      }
      default:
        return { code: 2, text: `unknown query command '${command ?? ''}' (symbol, refs, callers, callees, impl, di, routes, http, search, dump)`, json: null };
    }
  } finally {
    db.close();
  }
}
