// Integrity checks (contract Validation): schema per record, sorted unique ids, every referenced id exists,
// contexts, snippets; evidence against the analysed commit when its blob map is available.
import { schema, validate } from './schema.ts';
import { compareOrdinal } from '../util/canonical.ts';

export type Rec = Record<string, unknown> & { id: string };

export interface RecordSet {
  projects: Rec[];
  entities: Rec[];
  declarations: Rec[];
  relations: Rec[];
  evidence: Rec[];
  observations: Rec[];
  links: Rec[];
  diagnostics: Rec[];
  snippets: Rec[];
}

export const FILES: Record<keyof RecordSet, string> = {
  projects: 'graph/projects.ndjson',
  entities: 'graph/entities.ndjson',
  declarations: 'graph/declarations.ndjson',
  relations: 'graph/relations.ndjson',
  evidence: 'graph/evidence.ndjson',
  observations: 'graph/observations.ndjson',
  links: 'graph/links.ndjson',
  diagnostics: 'graph/diagnostics.ndjson',
  snippets: 'snippets.ndjson',
};

export const KNOWN_RELATION_KINDS = new Set(['declares', 'contains', 'references', 'calls_declared_target', 'overrides', 'implements', 'inherits', 'possible_runtime_target']);
export const KNOWN_OBSERVATION_KINDS = new Set([
  'di.registers', 'di.consumes', 'http.endpoint', 'http.call', 'grpc.proto', 'grpc.service', 'grpc.call', 'messaging.publish', 'messaging.subscribe', 'config.key',
  'topology.resource', 'topology.reference', 'data.maps_to',
  'inprocess.send', 'inprocess.handler', 'eventstore.append', 'eventstore.projection', 'realtime.hub', 'realtime.send', 'realtime.subscribe', 'search.index',
  'workflow.process', 'workflow.node', 'workflow.flow', 'workflow.handler', 'data.table', 'infra.resource', 'ui.component', 'ui.uses_component', 'ui.route',
]);
export const KNOWN_LINK_KINDS = new Set(['consumes_contract', 'configured_route', 'possible_communication', 'dispatches_to', 'implemented_by_package', 'pushes_to']);

const SCHEMA_OF: Record<keyof RecordSet, string> = {
  projects: 'project',
  entities: 'entity',
  declarations: 'declaration',
  relations: 'relation',
  evidence: 'evidence',
  observations: 'observation',
  links: 'link',
  diagnostics: 'diagnostic',
  snippets: 'snippet',
};

export interface IntegrityResult {
  errors: string[];
  notes: string[];
}

/** Every string value starting with `ts:` inside an observation must name an entity. */
function entityRefs(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('ts:')) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => entityRefs(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => entityRefs(v, out));
}

export function checkIntegrity(set: RecordSet, blobs?: Map<string, string>): IntegrityResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const max = 50;
  const err = (m: string) => {
    if (errors.length < max) errors.push(m);
    else if (errors.length === max) errors.push('... further errors omitted');
  };
  for (const key of Object.keys(FILES) as (keyof RecordSet)[]) {
    const records = set[key];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const s = key === 'projects' && r.recordType === 'analysisContext' ? schema('analysis-context') : schema(SCHEMA_OF[key]);
      for (const e of validate(s, r)) err(`${FILES[key]} ${r.id ?? `#${i + 1}`}: ${e}`);
      if (i > 0 && compareOrdinal(records[i - 1].id, r.id) >= 0) err(`${FILES[key]}: ids not sorted and unique at ${r.id}`);
    }
  }
  const ids = (list: Rec[]) => new Set(list.map((r) => r.id));
  const entities = ids(set.entities);
  const evidence = ids(set.evidence);
  const observations = ids(set.observations);
  const snippets = ids(set.snippets);
  const contexts = new Set(set.projects.filter((p) => p.recordType === 'analysisContext').map((p) => p.id));
  const projectIds = new Set(set.projects.filter((p) => p.recordType === 'project').map((p) => p.id));
  const projectPaths = new Set(set.projects.filter((p) => p.recordType === 'project').map((p) => p.path as string));
  for (const c of set.projects.filter((p) => p.recordType === 'analysisContext')) {
    if (!projectIds.has(c.projectId as string)) err(`context ${c.id}: unknown project ${c.projectId}`);
  }
  for (const e of set.entities) {
    if (e.container !== null && !entities.has(e.container as string)) err(`entity ${e.id}: unknown container ${e.container}`);
  }
  for (const d of set.declarations) {
    if (!entities.has(d.entity as string)) err(`declaration ${d.id}: unknown entity ${d.entity}`);
    if (!contexts.has(d.context as string)) err(`declaration ${d.id}: unknown context ${d.context}`);
    if (blobs && blobs.get(d.path as string) !== d.blobId) err(`declaration ${d.id}: '${d.path}' is not blob ${d.blobId} in the analysed commit`);
  }
  const unknownKinds = new Map<string, number>();
  for (const r of set.relations) {
    if (!entities.has(r.from as string)) err(`relation ${r.id}: unknown from ${r.from}`);
    if (!entities.has(r.to as string)) err(`relation ${r.id}: unknown to ${r.to}`);
    if (r.declaredTarget !== undefined && !entities.has(r.declaredTarget as string)) err(`relation ${r.id}: unknown declaredTarget ${r.declaredTarget}`);
    if (!contexts.has(r.context as string)) err(`relation ${r.id}: unknown context ${r.context}`);
    for (const e of r.evidence as string[]) if (!evidence.has(e)) err(`relation ${r.id}: unknown evidence ${e}`);
    if (!KNOWN_RELATION_KINDS.has(r.kind as string)) unknownKinds.set(`relation ${r.kind}`, (unknownKinds.get(`relation ${r.kind}`) ?? 0) + 1);
  }
  for (const e of set.evidence) {
    if (!contexts.has(e.context as string)) err(`evidence ${e.id}: unknown context ${e.context}`);
    if (e.snippet !== undefined && !snippets.has(e.snippet as string)) err(`evidence ${e.id}: unknown snippet ${e.snippet}`);
    if (blobs && e.store === 'repository' && blobs.get(e.path as string) !== e.blobId) err(`evidence ${e.id}: '${e.path}' is not blob ${e.blobId} in the analysed commit`);
  }
  for (const o of set.observations) {
    if (!contexts.has(o.context as string)) err(`observation ${o.id}: unknown context ${o.context}`);
    if (!projectPaths.has(o.project as string)) err(`observation ${o.id}: unknown project ${o.project}`);
    for (const e of o.evidence as string[]) if (!evidence.has(e)) err(`observation ${o.id}: unknown evidence ${e}`);
    const refs: string[] = [];
    const { id: _id, evidence: _ev, ...fields } = o;
    entityRefs(fields, refs);
    for (const ref of refs) if (!entities.has(ref)) err(`observation ${o.id}: unknown entity ${ref}`);
    if (!KNOWN_OBSERVATION_KINDS.has(o.kind as string)) unknownKinds.set(`observation ${o.kind}`, (unknownKinds.get(`observation ${o.kind}`) ?? 0) + 1);
  }
  for (const l of set.links) {
    const from = l.from as Rec;
    const to = l.to as Rec | null;
    if (!observations.has(from.observation as string)) err(`link ${l.id}: unknown from observation ${from.observation}`);
    if (to && !observations.has(to.observation as string)) err(`link ${l.id}: unknown to observation ${to.observation}`);
    if (!to && l.resolution !== 'unresolved') err(`link ${l.id}: no target but resolution ${l.resolution}`);
    for (const e of l.evidence as string[]) if (!evidence.has(e)) err(`link ${l.id}: unknown evidence ${e}`);
    if (!KNOWN_LINK_KINDS.has(l.kind as string)) unknownKinds.set(`link ${l.kind}`, (unknownKinds.get(`link ${l.kind}`) ?? 0) + 1);
  }
  const snippetBlobs = new Set(set.evidence.map((e) => e.blobId as string));
  for (const s of set.snippets) if (!snippetBlobs.has(s.blobId as string)) err(`snippet ${s.id}: no evidence uses blob ${s.blobId}`);
  for (const [k, n] of [...unknownKinds].sort(([a], [b]) => compareOrdinal(a, b))) notes.push(`kind not in contract v1.1: ${k} (${n} records; kept, excluded from contract traversal)`);
  return { errors, notes };
}
