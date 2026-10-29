// Links inside the repository (PLAN Step 4, contract Links) and possible runtime targets (after every context).
// Rules read only normalized observation fields; each link carries the evidence of both sides.
import type { Generation, Rec, Resolution } from './model.ts';
import { compareOrdinal } from './util/canonical.ts';

function byKind(gen: Generation, kind: string): Rec[] {
  return [...gen.observations.values()].filter((o) => o.kind === kind).sort((a, b) => compareOrdinal(a.id, b.id));
}

function ev(...records: Rec[]): string[] {
  return records.flatMap((r) => r.evidence as string[]);
}

export function buildLinks(gen: Generation): void {
  // DI: di.consumes -> di.registers by service token. Several providers: ambiguous (the injector hierarchy decides).
  const registrations = new Map<string, Rec[]>();
  for (const r of byKind(gen, 'di.registers')) {
    const list = registrations.get(r.service as string) ?? [];
    list.push(r);
    registrations.set(r.service as string, list);
  }
  for (const c of byKind(gen, 'di.consumes')) {
    const service = c.service as string;
    const candidates = registrations.get(service) ?? [];
    if (candidates.length === 0) {
      const fromPackage = service.startsWith('ts:pkg:');
      gen.addLink('consumes_contract', 'di', c, null, 'unresolved', ev(c), fromPackage ? 'the token comes from a package; its providers are not analysed' : 'no provider of this token was found in the analysed code');
      continue;
    }
    const resolution: Resolution = candidates.length === 1 ? 'exact' : 'ambiguous';
    for (const r of candidates) gen.addLink('consumes_contract', 'di', c, r, resolution, ev(c, r));
  }

  // In-process dispatch: inprocess.send -> inprocess.handler by request (fan-out: every handler receives the action, D18).
  const handlers = new Map<string, Rec[]>();
  for (const h of byKind(gen, 'inprocess.handler')) {
    const list = handlers.get(h.request as string) ?? [];
    list.push(h);
    handlers.set(h.request as string, list);
  }
  for (const s of byKind(gen, 'inprocess.send')) {
    const targets = handlers.get(s.request as string) ?? [];
    if (targets.length === 0) gen.addLink('dispatches_to', 'inprocess', s, null, 'unresolved', ev(s), 'no effect or reducer handles this action in the analysed code');
    for (const h of targets) gen.addLink('dispatches_to', 'inprocess', s, h, 'exact', ev(s, h));
  }

  // UI: ui.uses_component -> ui.component of the used component (in this repository).
  const components = new Map<string, Rec>();
  for (const c of byKind(gen, 'ui.component')) if (!components.has(c.component as string)) components.set(c.component as string, c);
  for (const u of byKind(gen, 'ui.uses_component')) {
    if (u.to === 'unresolved') {
      gen.addLink('renders', 'ui', u, null, 'unresolved', ev(u), String(u.reason ?? 'no component matches'));
      continue;
    }
    const target = components.get(u.to as string);
    if (target) gen.addLink('renders', 'ui', u, target, 'exact', ev(u, target));
  }
}

/** possible_runtime_target: calls to interface or abstract members, to every known implementation (always candidate). */
export function possibleRuntimeTargets(gen: Generation): void {
  const implementers = new Map<string, Set<string>>();
  for (const r of gen.relations.values()) {
    if (r.kind !== 'implements' && r.kind !== 'overrides') continue;
    const set = implementers.get(r.to as string) ?? new Set();
    set.add(r.from as string);
    implementers.set(r.to as string, set);
  }
  const all = (target: string): string[] => {
    const out = new Set<string>();
    const queue = [target];
    while (queue.length > 0) {
      const t = queue.shift()!;
      for (const m of implementers.get(t) ?? []) {
        if (out.has(m)) continue;
        out.add(m);
        queue.push(m);
      }
    }
    return [...out].sort(compareOrdinal);
  };
  const isDispatchable = (id: string): boolean => {
    const e = gen.entities.get(id);
    if (!e || (e.kind !== 'method' && e.kind !== 'property' && e.kind !== 'accessor')) return false;
    if ((e.modifiers as string[]).includes('abstract')) return true;
    const container = e.container ? gen.entities.get(e.container as string) : undefined;
    return container?.kind === 'interface';
  };
  for (const r of [...gen.relations.values()].sort((a, b) => compareOrdinal(a.id, b.id))) {
    if (r.kind !== 'calls_declared_target' || !isDispatchable(r.to as string)) continue;
    for (const impl of all(r.to as string)) {
      const e = gen.entities.get(impl);
      if (e?.origin !== 'source') continue;
      gen.addRelation('possible_runtime_target', r.from as string, impl, r.context as string, 'candidate', r.evidence as string[], { declaredTarget: r.to });
    }
  }
}
