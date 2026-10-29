# Decisions

Format per entry: context, options, choice, reason, how to revisit. Status `accepted` means it is in force; `proposed` means it waits for the owner or for the contract owner. Numbers are prefixed `A` so they do not collide with the shared contract decisions (`D*`, intelligence-contract `docs/DECISIONS.md`).

## A1: Repository home

- **Context:** the engine needs GitHub Actions, GHCR and arm64 runners (Step 1).
- **Options:** public repository under `AlbertoMitroi`; private repository.
- **Choice:** public `AlbertoMitroi/angular-intelligence`, local checkout `~/repos/devos/angular-intelligence`. The remote is created when CI first runs.
- **Reason:** same as dotnet-intelligence D1: free arm64 runners, and callers pull the Action image without credentials.
- **Revisit:** if the engine must become private.
- **Status:** accepted.

## A2: Runtime and image

- **Context:** the engine is TypeScript; it runs only in Docker on the host.
- **Options:** compile to JavaScript in a build stage; run the sources with Node type stripping.
- **Choice:** `node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` (Node 24.22.2), apt pins `git=1:2.39.5-0+deb12u3` and `ca-certificates=20250419~deb12u2`, sources run with type stripping (`erasableSyntaxOnly`, no parameter properties, no `declare` member names). `node:sqlite` with FTS5 (SQLite 3.53.4) for the index. The test stage runs `tsc --noEmit` and the unit tests.
- **Reason:** no build output to keep in sync; stack traces point at the sources; `node:sqlite` avoids a native module.
- **Revisit:** when Node 26 becomes LTS (new digest and image release).
- **Status:** accepted.

## A3: TypeScript compiler (spike S1)

- **Context:** the type checker decides every semantic relation. TypeScript 7 is the native (Go) port.
- **Options:** the TypeScript 7 API; the 6.x JavaScript compiler API; the repository's own TypeScript.
- **Result of S1** (`docs/spikes/s1-typescript7.txt`, `docs/spikes/s1-typescript7-api.txt`): the `typescript@7.0.2` main export holds only `version` and `versionMajorMinor`; the checker exists only under `typescript/unstable/sync` and `unstable/async`, which talk over IPC to a per-platform native binary (`@typescript/typescript-linux-arm64` and siblings). The API is marked unstable.
- **Choice:** the repository's TypeScript when it is 4.8 to 6.x (its own semantics, its own `lib` files); otherwise the engine's pinned `typescript@6.0.3`, with the reason. Each analysis context reports `ext.typescript.compiler`, `compilerSource` (`repository` or `engine`) and the reason. For the engine compiler on old configurations, `ignoreDeprecations: "6.0"` is set.
- **Reason:** an unstable IPC API and a native binary per platform would make the amd64 and arm64 images differ in behaviour; 6.x reads TypeScript 7 projects that keep 6.x-compatible options.
- **Revisit:** when TypeScript 7 publishes a stable in-process or IPC checker API.
- **Status:** accepted.

## A4: Angular template parsing (spike S2)

- **Context:** templates reference members, components, directives and pipes; their syntax changed across Angular majors (control flow blocks, `@let`, signals).
- **Options:** the engine's `@angular/compiler` for every repository; the repository's own compiler.
- **Result of S2** (`docs/spikes/s2-template-parsing.txt`): `parseTemplate` parses `@if`, `@for`, `@empty`, `@defer`, signals and `*ngIf` without errors on 22.2.3, 18.1.4 and 17.3.12; 16.2.12 reports 2 errors on control flow blocks (they did not exist). AST class names differ between versions (`Element$1` in 18), so nodes are matched with `instanceof` against the `TmplAst*` exports of the compiler that parsed them.
- **Choice:** the repository's `@angular/compiler` when it is 14 or later, otherwise the engine's `22.2.3`; reported as `ext.typescript.angularCompiler` and `angularCompilerSource`. Template parse errors are a `template-parse-error` diagnostic (partial), never silence.
- **Reason:** the repository's compiler accepts exactly the template syntax that repository compiles with.
- **Revisit:** when a new block type appears (the visitor lists child collections explicitly: `children`, `branches`, `groups`, `cases`, `empty`, `placeholder`, `loading`, `error`). Fixture 8 caught `@switch` `groups` (Angular 21 and later) missing from that list.
- **Status:** accepted.

## A5: Install without scripts (spike S3)

- **Context:** a semantic program needs `node_modules`; repository code must never run.
- **Result of S3** (`docs/spikes/s3-install-ignore-scripts.txt`) on eShopOnAbp `apps/angular` at `7bfed7a322d16b34a5a66208c03486fa5dfacee9`: Angular 18.1.5, TypeScript 5.4.5, no lockfile. `npm install --ignore-scripts` failed on a peer conflict; the retry with `--legacy-peer-deps` succeeded in 105 s. Six packages declare install scripts (esbuild, fsevents, lmdb, msgpackr-extract, the esbuild of ng-packagr, nice-napi); none is needed for type checking. The TypeScript 5.4.5 program had 64 own files, 0 semantic errors, 0 unresolved identifiers among 1087.
- **Choice:** the lockfile picks the manager (`npm ci`, `corepack pnpm install --frozen-lockfile`, `corepack yarn install --frozen-lockfile` or `--immutable --mode=skip-build`), always without scripts, cache in `/cache`. Without a lockfile: `npm install --no-package-lock` plus a `lockfile-missing` diagnostic, and one retry with `--legacy-peer-deps` on `ERESOLVE`, reported as `install-retried`. A failed install gives `install-failed`, the parser-only fallback (`syntax`), status `partial`, exit code 10 (fixture 13).
- **Reason:** results stay reproducible where a lockfile exists and honest where it does not.
- **Revisit:** if a package's types are generated by its install script.
- **Status:** accepted.

## A6: Configuration destinations in observations (deviation from rule 1.4.6, contract D20)

- **Context:** rule 1.4.6 says configuration values never reach the output. HTTP and SignalR links need the destination (base URL) to be useful.
- **Choice:** confirmed by the owner (relayed by the dotnet-intelligence context engine session, 2026-10-29): a configuration value used as a destination may be stored in an observation when neither its key nor its value is flagged secret, with `nameSource: configuration`. This covers base URLs from environment files (per configuration), `proxy.conf` targets and SignalR hub URLs. Secret keys or values give `secret: true` and no value. `config.key` keeps keys only. Secret detection (`src/secrets.ts`) is shared by snippets, `config.key` and destinations; any key name ending in `key` counts as secret (fixture 12 caught `fallbackKey = '...'` in a snippet), which errs on the side of redacting.
- **Reason:** shared contract decision D20; the same rule as dotnet-intelligence.
- **Revisit:** with the contract.
- **Status:** accepted (deviation from rule 1.4.6, recorded here as required).

## A7: Contract vendoring and drift check

- **Context:** the engine writes contract v1.1 records validated against the shared schema.
- **Choice:** `schema/v1/*.schema.json` vendored from intelligence-contract `ea4975a9f9f1891a1951278a2facbb6d2260817b`; `schema/VENDOR.json` lists each file's SHA-256 and a unit test fails on any difference. `schemaVersion` is `1.1`. The manifest uses `toolchain` (no Roslyn or SDK fields).
- **Reason:** one writer for the contract (the dotnet-intelligence-sdk session); a local edit cannot slip in unnoticed.
- **Revisit:** each contract release (re-vendor, update `VENDOR.json`).
- **Status:** accepted.

## A8: Entity ids

- **Choice:** `ts:{projectPath}:{modulePath}#{symbolPath}` as contract v1.1 defines it: the project path and the module path are both repository-relative, the module path without extension (`ts:libs/ui:libs/ui/src/lib/button.component#ButtonComponent`, fixture 14). The module itself has an empty symbol path (`ts:.:src/main#`). Overloads append the parameter types as written, whitespace collapsed (`format(number)`, `format(string | number)`). Package symbols: `ts:pkg:{name}@{version}:{modulePath}#{symbolPath}`. Code in lambdas and locals belongs to its container (contract D6).
- **Reason:** stable across runs and machines, readable, and unique for overloads (fixture 9).
- **Status:** accepted.

## A9: Observation and link kinds outside contract v1.1

- **Context:** Angular has concepts the v1.1 kind list does not name.
- **Choice:** contract v1.1 already names `ui.component`, `ui.uses_component`, `ui.route`, `realtime.subscribe`, `inprocess.send`, `inprocess.handler` and the link `dispatches_to`; the engine uses those as defined. It also emits, as compatibility rule 4 allows, observations `ui.directive`, `ui.pipe`, `ui.module`, `ui.uses_directive`, `http.interceptor`, `http.proxy`, `realtime.connection`, `realtime.invoke` (client to server; v1.1 `realtime.send` is the server side), `state.action`, and the link `renders` (via `ui`, which v1.1 allows). `verify` prints each of these as a note with its count (fixtures 1 to 15: nine such kinds seen).
- **Revisit:** propose them to the contract owner for v1.2 (to ask before any edit of intelligence-contract).
- **Status:** proposed.

## A10: HTTP client conventions by configuration

- **Context:** eShopOnAbp calls its APIs through `@abp/ng.core` `RestService.request({ method, url }, { apiName })`, not `HttpClient`. Naming ABP in the engine would break the rule "no repository-specific names in the engine".
- **Choice:** the caller declares wrappers in `config.yml` (`http.clients[]`: package, qualified method, which argument holds the request and which properties hold method and URL, and optionally the argument and property that pick an environment base key). Calls are matched by resolved symbol and emitted as `http.call` with `ext.angular.via: convention` and the convention name.
- **Reason:** generic, explicit, and the evidence still points at the call.
- **Status:** accepted; exercised in the eShopOnAbp validation (Step 4 gate).

## A11: DI links

- **Choice:** `di.consumes` links to every `di.registers` of the same token: one provider gives `exact`, several give `ambiguous` (the injector hierarchy decides at run time). Exception: when the consuming component lists the token in its own `providers` or `viewProviders`, that registration alone is the target, `exact` (its element injector answers first; fixture 4, and the ABP `providers: [ListService]` pattern in eShopOnAbp); a token from a package gives `unresolved` with reason "the token comes from a package; its providers are not analysed"; a source token without provider gives `unresolved` with its own reason (fixture 3).
- **Status:** accepted.

## A12: Route paths

- **Choice:** routes reached from a root router configuration (`provideRouter`, `RouterModule.forRoot`) carry the full path with one leading `/` (`/orders/:id`, `/admin/users` through `loadChildren`). A `Routes` table no root configuration reaches gets `path: null`, `ext.angular.relativePath` and a reason (fixture 5).
- **Reason:** unknown is not empty: a guessed parent would be wrong more often than a missing one.
- **Status:** accepted.

## A13: URLs that cannot be folded

- **Choice:** when nothing of the path is known (the URL is a parameter or an unfoldable expression), `canonicalRoute` is `null`, `urlTemplate` is `{}` and the resolution is `unresolved` with a reason. Context packs print "unknown route". A known prefix with an unknown tail keeps its route (`/orders/{}`).
- **Reason:** `/` would claim the root route (fixture 6 caught the engine emitting `/` as `candidate`).
- **Status:** accepted.

## A14: The Action runs as root

- **Context:** a Docker container Action mounts the workspace owned by the runner user; the image's default user is `node`.
- **Choice:** the `action` stage sets `USER root`; `gha.ts` changes the owner of everything it writes back to the owner of the workspace. The CLI image (`runtime` stage) stays non-root, which the self-test checks.
- **Status:** accepted.

## A15: Disk use of verify.sh

- **Context:** the host's Docker disk is shared by several sessions and filled up during Step 3.
- **Choice:** `/work` (the exported working copy and its `node_modules`) is a tmpfs of 4 GiB per container; only the npm cache (`/cache`) is a volume. No pruning or image deletion by the engine's scripts.
- **Status:** accepted.

## A16: Determinism

- **Choice:** canonical JSON, ids from content hashes, ordinal sorting everywhere, spans in UTF-16 code units with the BOM not counted and CRLF kept as committed (fixture 15). Byte comparison between runs and between amd64 and arm64 excludes only `run.json`, `index.sqlite` (compared through its canonical dump), event streams, logs and `version.json`. The CLI exits only after stdout and stderr are flushed: `process.exit()` right after a large write truncated piped output at 64 KiB (found when the `query dump` of fixture 6 differed between runs).
- **Status:** accepted.
