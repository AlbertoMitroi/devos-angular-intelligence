// Context packs (PLAN 3.5): deterministic Markdown. Application overview (routes tree, feature areas), one card per
// project, one per service with its HTTP calls. Every statement cites evidence; every card ends with what could not
// be determined; cut lists say how many items were omitted and how to get them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordSet, Rec } from './integrity.ts';
import { compareOrdinal, sha256Hex } from '../util/canonical.ts';

const LIMIT = 200;

interface Ctx {
  set: RecordSet;
  evidence: Map<string, Rec>;
  entities: Map<string, Rec>;
  commit: string;
  status: string;
}

function at(ctx: Ctx, ids: unknown): string {
  const list = (ids as string[]) ?? [];
  const cites = list
    .map((id) => ctx.evidence.get(id))
    .filter((e): e is Rec => !!e)
    .map((e) => `${e.path}:${(e.span as { startLine: number }).startLine}`);
  return [...new Set(cites)].sort(compareOrdinal).map((c) => `\`${c}\``).join(', ');
}

function name(ctx: Ctx, id: unknown): string {
  if (typeof id !== 'string') return '(none)';
  if (id === 'unresolved' || id === 'inline' || id === 'unknown') return id;
  const e = ctx.entities.get(id);
  return e ? `\`${e.name}\`` : `\`${id}\``;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function capped<T>(items: T[], render: (t: T) => string, query: string): string[] {
  const out = items.slice(0, LIMIT).map(render);
  if (items.length > LIMIT) out.push(`\n${items.length - LIMIT} more omitted; get them with \`${query}\`.`);
  return out;
}

export function slug(text: string): string {
  return text === '.' ? 'root' : text.replace(/[^A-Za-z0-9._-]+/g, '__');
}

function baseText(base: unknown): string {
  if (!base || typeof base !== 'object') return 'same origin';
  const b = base as Record<string, any>;
  const values = Array.isArray(b.values) ? b.values.map((v: any) => `${v.configuration}${v.application ? `@${v.application}` : ''}=${v.secret ? '(secret)' : v.value ?? '(not a literal)'}`).join(', ') : b.value ?? '';
  return `${b.source}${b.key ? ` \`${b.key}\`` : ''}${b.prefix ? ` \`${b.prefix}\`` : ''}${values ? ` (${values})` : ''}`;
}

function gaps(ctx: Ctx, filter: (d: Rec) => boolean, extra: string[]): string[] {
  const lines = ['', '## What could not be determined', ''];
  const diags = ctx.set.diagnostics.filter(filter);
  for (const d of diags.slice(0, LIMIT)) lines.push(`- ${d.state} \`${d.code}\` (${d.scope}): ${d.message}`);
  if (diags.length > LIMIT) lines.push(`- ${diags.length - LIMIT} more diagnostics omitted; see \`graph/diagnostics.ndjson\`.`);
  lines.push(...extra);
  if (diags.length === 0 && extra.length === 0) lines.push('- Nothing reported for this scope. Runtime behaviour (values chosen at run time, server responses) is out of scope by design.');
  return lines;
}

export function writePacks(outDir: string, set: RecordSet, commit: string, status: string, repository: string): string[] {
  const ctx: Ctx = {
    set,
    evidence: new Map(set.evidence.map((e) => [e.id, e])),
    entities: new Map(set.entities.map((e) => [e.id, e])),
    commit,
    status,
  };
  const written: string[] = [];
  const write = (rel: string, lines: string[]) => {
    const full = join(outDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
    written.push(rel);
  };
  const obs = (kind: string) => set.observations.filter((o) => o.kind === kind);
  const projects = set.projects.filter((p) => p.recordType === 'project');
  const contexts = set.projects.filter((p) => p.recordType === 'analysisContext');
  const routes = obs('ui.route').filter((r) => r.path !== null).sort((a, b) => compareOrdinal(a.path as string, b.path as string) || compareOrdinal(a.id, b.id));
  const calls = obs('http.call').sort((a, b) => compareOrdinal(a.canonicalRoute as string, b.canonicalRoute as string) || compareOrdinal(a.method as string, b.method as string) || compareOrdinal(a.id, b.id));

  // Overview.
  const o: string[] = [`# Overview: ${repository}`, '', `Commit \`${commit}\`, generation status **${status}**. Produced by angular-intelligence; every line cites \`path:line\` evidence.`, '', '## Projects', '', '| Project | Kind | Type | Load mode | Compiler | Compilation errors |', '|---|---|---|---|---|---|'];
  for (const p of projects) {
    const c = contexts.find((x) => x.projectId === p.id);
    const ang = (p.ext as any)?.angular ?? {};
    const tsExt = (c?.ext as any)?.typescript ?? {};
    o.push(`| \`${p.path}\` (${cell(String(ang.name ?? ''))}) | ${ang.kind ?? ''} | ${ang.projectType ?? ''} | ${c?.loadMode ?? 'not-analyzed'} | typescript ${tsExt.compiler ?? '?'} (${tsExt.compilerSource ?? '?'}) | ${c?.compilationErrors ?? ''} |`);
  }
  o.push('', '## Routes', '');
  if (routes.length === 0) o.push('No route reached from a root router configuration.');
  o.push(...capped(routes, (r) => {
    const target = r.component ? `component ${name(ctx, r.component)}` : r.loadComponent ? `loadComponent ${name(ctx, r.loadComponent)}` : r.loadChildren ? `loadChildren ${name(ctx, r.loadChildren)}` : r.redirectTo !== null ? `redirect to \`${r.redirectTo}\`` : 'no component';
    const guards = Object.entries((r.guards as Record<string, string[]>) ?? {}).map(([k, v]) => `${k}: ${v.map((g) => name(ctx, g)).join(', ')}`).join('; ');
    return `- \`${r.path}\`: ${target}${guards ? `; ${guards}` : ''} (${at(ctx, r.evidence)})`;
  }, 'query <generation> routes'));
  const areas = new Map<string, number>();
  for (const r of routes) {
    const seg = (r.path as string).split('/').filter(Boolean)[0] ?? '(root)';
    areas.set(seg, (areas.get(seg) ?? 0) + 1);
  }
  o.push('', '## Feature areas', '', 'First route segment and the number of routes below it.', '');
  for (const [seg, n] of [...areas].sort(([a], [b]) => compareOrdinal(a, b))) o.push(`- \`${seg}\`: ${n}`);
  o.push('', '## HTTP calls', '', '| Method | Route | Base address | Client | Resolution | Evidence |', '|---|---|---|---|---|---|');
  o.push(...capped(calls, (c) => `| ${c.method} | \`${c.canonicalRoute}\` | ${cell(baseText(c.baseAddress))} | ${name(ctx, c.client)} | ${c.resolution} | ${at(ctx, c.evidence)} |`, 'query <generation> http'));
  const rt = [...obs('realtime.connection'), ...obs('realtime.subscribe'), ...obs('realtime.invoke')].sort((a, b) => compareOrdinal(a.id, b.id));
  if (rt.length > 0) {
    o.push('', '## Real time', '');
    for (const r of rt) o.push(`- ${r.kind} ${r.route ? `\`${r.route}\`` : '(route unknown)'}${r.method ? ` method \`${r.method}\`` : ''} (${at(ctx, r.evidence)})`);
  }
  o.push(...gaps(ctx, (d) => d.severity !== 'info', calls.filter((c) => c.resolution !== 'exact').map((c) => `- http.call ${c.method} \`${c.canonicalRoute}\` is ${c.resolution}: ${c.reason ?? ''} (${at(ctx, c.evidence)})`)));
  write('context/overview.md', o);

  // Project cards.
  for (const p of projects) {
    const path = p.path as string;
    const ang = (p.ext as any)?.angular ?? {};
    const c = contexts.find((x) => x.projectId === p.id);
    const inProject = (r: Rec) => r.project === path;
    const lines: string[] = [`# Project ${ang.name ?? path} (\`${path}\`)`, '', `Kind ${ang.kind}, type ${ang.projectType}, load mode **${c?.loadMode ?? 'not-analyzed'}**${c ? ` (${c.reason})` : ''}. tsconfig \`${ang.tsConfig ?? 'none'}\`.`, ''];
    const comps = obs('ui.component').filter(inProject).sort((a, b) => compareOrdinal(a.component as string, b.component as string));
    lines.push('## Components', '');
    if (comps.length === 0) lines.push('None.');
    lines.push(...capped(comps, (x) => `- ${name(ctx, x.component)} selector \`${x.selector ?? '(none)'}\`, template \`${x.template ?? '(none)'}\` (${at(ctx, x.evidence)})`, `query <generation> search ui.component`));
    const regs = obs('di.registers').filter(inProject).sort((a, b) => compareOrdinal(a.id, b.id));
    lines.push('', '## Providers', '');
    if (regs.length === 0) lines.push('None.');
    lines.push(...capped(regs, (x) => `- ${name(ctx, x.service)} as ${x.implementation ? name(ctx, x.implementation) : x.factory ? `factory ${name(ctx, x.factory)}` : x.existing ? `alias of ${name(ctx, x.existing)}` : x.value ? 'value' : '?'}, scope ${x.lifetime} (${at(ctx, x.evidence)})`, `query <generation> di <token>`));
    const rts = routes.filter(inProject);
    lines.push('', '## Routes', '');
    if (rts.length === 0) lines.push('None reached from a root configuration in this project.');
    lines.push(...capped(rts, (r) => `- \`${r.path}\` (${at(ctx, r.evidence)})`, 'query <generation> routes'));
    const pc = calls.filter(inProject);
    lines.push('', '## HTTP calls', '');
    if (pc.length === 0) lines.push('None.');
    lines.push(...capped(pc, (x) => `- ${x.method} \`${x.canonicalRoute}\` base ${baseText(x.baseAddress)}, client ${name(ctx, x.client)}, ${x.resolution} (${at(ctx, x.evidence)})`, 'query <generation> http'));
    const pkgs = ((p.packages as Rec[]) ?? []).filter((x) => x.direct);
    lines.push('', '## Packages (direct)', '');
    if (pkgs.length === 0) lines.push('None recorded (install did not run or the project has no package.json).');
    lines.push(...capped(pkgs, (x) => `- \`${x.id}@${x.version}\``, 'graph/projects.ndjson'));
    lines.push(...gaps(ctx, (d) => d.scope === path || (d.scope as string).startsWith(path === '.' ? '' : path + '/'), pc.filter((x) => x.resolution !== 'exact').map((x) => `- http.call ${x.method} \`${x.canonicalRoute}\` is ${x.resolution}: ${x.reason ?? ''}`)));
    write(`context/projects/${slug(path)}.md`, lines);
  }

  // Service cards: classes that make HTTP calls.
  const byClient = new Map<string, Rec[]>();
  for (const c of calls) if (typeof c.client === 'string') byClient.set(c.client, [...(byClient.get(c.client) ?? []), c]);
  for (const [client, list] of [...byClient].sort(([a], [b]) => compareOrdinal(a, b))) {
    const e = ctx.entities.get(client);
    const consumers = obs('di.consumes').filter((x) => x.service === client).sort((a, b) => compareOrdinal(a.id, b.id));
    const lines: string[] = [`# Service ${e?.name ?? client}`, '', `Entity \`${client}\`, project \`${e?.project ?? '?'}\`.`, '', '## HTTP calls', ''];
    lines.push(...capped(list, (x) => `- ${x.method} \`${x.canonicalRoute}\` (template \`${x.urlTemplate}\`), base ${baseText(x.baseAddress)}, from ${name(ctx, x.caller)}, ${x.resolution} (${at(ctx, x.evidence)})`, `query <generation> http`));
    lines.push('', '## Injected into', '');
    if (consumers.length === 0) lines.push('No consumer found in the analysed code.');
    lines.push(...capped(consumers, (x) => `- ${name(ctx, x.consumer)} via ${x.via} (${at(ctx, x.evidence)})`, `query <generation> di ${client}`));
    lines.push(...gaps(ctx, () => false, list.filter((x) => x.resolution !== 'exact').map((x) => `- ${x.method} \`${x.canonicalRoute}\` is ${x.resolution}: ${x.reason ?? ''}`)));
    write(`context/services/${slug(e?.name as string ?? 'service')}-${sha256Hex(client).slice(0, 8)}.md`, lines);
  }
  return written.sort(compareOrdinal);
}
