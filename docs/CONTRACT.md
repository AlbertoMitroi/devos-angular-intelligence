# Contract v1.2 (TypeScript and Angular)

The format of a generation is the shared contract v1.2 (devos-intelligence-contract `docs/CONTRACT-v1.2.md`, tag `v1.2.0`; schemas vendored in [`schema/`](../schema/), A7). This page lists what the Angular engine writes. `schemaVersion` in the manifest: `1.2` (A17). Every observation has `site`, its exact location; kinds with a file in `schema/v1/kinds/` are validated against it.

## Layout

| Path | Content |
|---|---|
| `manifest.json` | Written last, after validation. Schema version, engine, `toolchain` (Node, engine TypeScript and `@angular/compiler`, SQLite, and per context the compiler that ran with its source and reason), repository, commit, object format, dirty, configuration hash, analysis contexts, coverage, installs, every file with SHA-256 and size |
| `graph/projects.ndjson` | `recordType: project` and `recordType: analysisContext` (load mode, tsconfig, `ext.typescript`) |
| `graph/entities.ndjson` | Logical symbols (`origin: source` or `package`) |
| `graph/declarations.ndjson` | Name span and extent of each declaration |
| `graph/relations.ndjson` | `contains`, `references` (with `usage`), `calls_declared_target`, `overrides`, `implements`, `inherits`, `possible_runtime_target` (always `candidate`, with `declaredTarget`) |
| `graph/evidence.ndjson` | Path, blob id, span, extractor, method (`semantic`, `syntax`, `metadata`, `config`, `configured-convention`), context, store |
| `graph/observations.ndjson` | Normalized facts from the Angular adapters |
| `graph/links.ndjson` | Relationships inside the repository |
| `graph/diagnostics.ndjson` | What failed, is partial, unsupported or unknown, with reasons |
| `snippets.ndjson` | Redacted source lines, keyed by blob id and line |
| `index.sqlite` | Index schema 1: the base tables of `schema/index/v1/index.sql` as written, meta `schemaVersion`, `commit`, `engine`, `indexSchema`, `status`, `coverage`; compared between runs through `query <generation> dump` |
| `context/` | Deterministic Markdown context packs: `overview.md`, `projects/{slug}.md`, `services/{name}-{hash8}.md` |
| `run.json` | Timings and counts; excluded from determinism checks; not listed in the manifest |

Every NDJSON file: one canonical JSON object per line (keys sorted ordinally, no whitespace, UTF-8 without BOM, `\n`), sorted by `id`.

## Identity

- Entity: `ts:{projectPath}:{modulePath}#{symbolPath}`, both paths repository-relative, the module path without extension (A8). The module itself: empty symbol path (`ts:.:src/main#`). Overloads: `#format(number)`. Package symbols: `ts:pkg:{name}@{version}:{modulePath}#{symbolPath}`.
- Code in arrow functions, callbacks and locals belongs to the containing entity (contract D6); an arrow function assigned to a property or variable is that property or variable.
- Other records: `{prefix}:{first 32 hex of SHA-256 of the canonical identifying fields}`.

## Locations

`span` is 1-based with columns in UTF-16 code units (contract D9); a BOM is not a column; CRLF files keep their lines (fixture 15). Template evidence points into the `.html` file, or into the `.ts` file at the inline template's position.

## Observations

| Kind | Since | Main fields |
|---|---|---|
| `di.registers` | v1.0 | `service`, `implementation`, `factory`, `existing`, `value`, `lifetime` (the `providedIn` string such as `root`, or `module`, `environment`, `component`, `route`, `unknown`), `registrationPath`, `multi` |
| `di.consumes` | v1.0 | `service`, `consumer`, `via` (`constructor`, `inject`), `ext.angular.flags` |
| `http.call` | v1.0 | `method`, `urlTemplate`, `canonicalRoute` (null when nothing of the path is known, A13), `baseAddress` (`source`: `environment`, `literal`, `interceptor`, `proxy`, `convention`, `unknown`; values per configuration, D20), `client`, `caller`, `resolution`, `reason` |
| `config.key` | v1.0 | `key`, `file`, `secret`, `configurations` (never the value) |
| `ui.component` | v1.1 | entity, `selector`, `template`, `ext.angular` (standalone, imports) |
| `ui.directive`, `ui.pipe`, `ui.module` | v1.2 (C4) | entity, selector or name, template, `ext.angular` (standalone, imports, declarations, exports) |
| `ui.uses_component` | v1.1 | `from`, `selector`, `to` (entity or `unresolved` with `reason`) |
| `ui.uses_directive` | v1.2 (C4) | `from`, `selector`, `to` (entity or `unresolved` with `reason`) |
| `ui.route` | v1.1 | `path` (full, or null with `ext.angular.relativePath` and reason), `component`, `loadComponent`, `loadChildren`, `redirectTo`, `guards`, `resolvers` |
| `http.interceptor`, `http.proxy` | v1.2 (C4) | interceptor entity, `urlPrefix`, `registered`; proxy `prefix`, `target` (D20), `secret`, `pathRewrite` |
| `realtime.subscribe` | v1.1 | hub `route`, `hub`, `method` |
| `realtime.connection`, `realtime.invoke` | v1.2 (C4) | hub `route`, `urlTemplate`, `baseAddress`, `method`, `mode` (`invoke`, `send`, `stream`) |
| `inprocess.send`, `inprocess.handler` | v1.1 | NgRx: action entity as `request`, `pattern: notification`; sender; handler with `ext.ngrx.role` (`effect` with `calls` and reached `httpCalls`, or `reducer`) |
| `state.action` | v1.2 (C4) | NgRx `action` entity, `type`, `mechanism` |

Unknown kinds follow compatibility rule 4: consumers keep them and exclude them from traversal; `verify` reports each as a note.

## Links

| Kind | Via | Rule |
|---|---|---|
| `consumes_contract` | `di` | consumer token to every provider of the token: one is `exact`, several `ambiguous`, the consumer component's own provider alone `exact`; none is `unresolved` with a reason (A11) |
| `renders` | `ui` (v1.2) | `ui.uses_component` to the used `ui.component` |
| `dispatches_to` | `inprocess` | `inprocess.send` to every `inprocess.handler` of the action (fan-out, contract D18) |

HTTP and SignalR calls are linked to backends by federation (outside the engine), through `canonicalRoute` and `baseAddress`.

## Validation

`analyze` validates its own output before writing the manifest (schema, sorted unique ids, every referenced id including `ts:` ids inside observations, snippets against blob ids); a failure means no manifest and exit code 50. `verify <generation>` repeats the checks and adds the manifest schema, capabilities, checksums and unlisted files.
