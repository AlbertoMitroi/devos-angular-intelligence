# angular-intelligence: plan (Step 0)

## Source of requirements

`../devos-dotnet-intelligence/docs/IMPLEMENTATION-PROMPT.md` applies **in full**, with the substitutions below. Parts 1 (rules), 2 (Docker-first, Action, CI, release), 3 (contract; now owned by `intelligence-contract`, v1.1 for TypeScript) and 5 (artifact builder) carry over unchanged in intent. Part 4 (extractor) is replaced by section 3 of this plan. Part 6 (eShop) is replaced by validation on the lab Angular app and on `abpframework/eShopOnAbp` `apps/angular`.

Owner decisions that apply: all projects under `~/repos/devos/` (local folder `angular-intelligence`), public GitHub repository under AlbertoMitroi when CI is needed, no em dashes in any text, worktree per writing session (rule 12).

## 1. Substitutions

| dotnet-intelligence | angular-intelligence |
|---|---|
| .NET 10 runtime, Roslyn semantic core | Node.js 24 LTS (`node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`, v24.22.2 on 2026-10-29), TypeScript compiler API as semantic core, `@angular/compiler` for templates |
| SDK set in the image | No SDK: the analysed repository's own `typescript` and `@angular/compiler` from its lockfile are used for fidelity; the engine pins its own fallback versions and reports which ran |
| `dotnet restore` into `/cache` | `npm ci` (or `pnpm install --frozen-lockfile`, `yarn --immutable`, chosen by lockfile) with `--ignore-scripts`, cache in `/cache` |
| MSBuildWorkspace load modes | `semantic` (program with type checker), `syntax` (parser only, when install fails), `failed` |
| Solutions and projects | `angular.json`, Nx `project.json`, npm/pnpm/yarn workspaces; each Angular application or library is a project, its `tsconfig` decides the program |
| Entity ids `dotnet:` | `ts:{projectPath}:{modulePath}#{symbolPath}` and `ts:pkg:` (contract v1.1) |
| `appsettings*.json` | `src/environments/*.ts`, `proxy.conf.json`/`proxy.conf.js`, `angular.json` file replacements |

## 2. Spikes (start of Step 1)

- **S1 TypeScript 7.** npm `latest` is `typescript@7.0.2` (the native Go port, 2026-10-29). Verify which programmatic API it exposes for a type checker in Node; if the JavaScript API is not available, use the 6.x JavaScript API for analysis and record the TypeScript version the repository builds with (the analysis then uses a different compiler, reported as such, like the Roslyn rule).
- **S2 Angular version range.** Latest `@angular/core` and `@angular/compiler` are 22.2.3. Confirm template parsing of standalone components, control flow blocks (`@if`, `@for`, `@defer`) and signals with `@angular/compiler` of the repository's version; eShopOnAbp `apps/angular` is older (ABP 9, Angular 18 or 19), the lab app uses the latest.
- **S3 Install without scripts.** `--ignore-scripts` keeps analysed code from running at install; confirm the program still type-checks (some packages need postinstall).

## 3. Extractor (replaces Part 4)

1. Working copy, discovery, preflight (lockfile present, package manager and versions), install (offline with full cache), load (`ts.createProgram` per project `tsconfig`, project references followed).
2. Extraction with the type checker: entities (classes, interfaces, type aliases, enums, functions, methods, properties, accessors, exported constants), declarations (all overloads and declaration merging), `contains`, `references` with usage (`read`, `write`, `invocation`, `typeof`, `decorator`, `import`, `other`), `calls_declared_target`, `inherits`, `implements`, `overrides`, `possible_runtime_target` (interface and abstract members to known implementations), imports between modules.
3. Angular adapters, by resolved symbol from `@angular/*` only:
   - `@Component` (selector, standalone `imports`, `templateUrl` or inline template, `styleUrls`), `@Directive`, `@Pipe`, `@NgModule` (declarations, imports, providers, bootstrap), `@Injectable` (`providedIn`).
   - DI: constructor parameters, `inject()` calls, `providers` arrays (`useClass`, `useValue`, `useFactory`, `useExisting`), `InjectionToken`s; links consumer → provider within the injector hierarchy that can be determined statically.
   - Routing: `Routes` arrays, `RouterModule.forRoot/forChild`, `provideRouter`, nested `children`, lazy `loadChildren` and `loadComponent` (dynamic imports resolved to modules), guards and resolvers. Output `ui.route` with the full path.
   - Templates: elements and attributes matched to component and directive selectors in scope (`ui.uses_component`), event bindings to component methods (`(click)="save()"` → `references` with usage `invocation`), property bindings, control flow blocks; template spans mapped to the `.html` file or the inline template.
   - HTTP: `HttpClient.get/post/put/patch/delete/request` with URL templates (string literals, template literals, concatenation, constants and `environment.*` folded); base URL from `environment` files and `angular.json` file replacements per configuration, interceptors that prefix URLs (when the prefix is a constant), `proxy.conf.json` targets; output `http.call` with `canonicalRoute`.
   - Real time: `@microsoft/signalr` `HubConnectionBuilder().withUrl(...)`, `.on(method)` and `.invoke/send(method)` → `realtime.subscribe` and client calls.
   - NgRx when present: actions, effects (which actions they react to and which HTTP calls they make), reducers.
4. Syntax fallback (parser only) when install or program creation fails.
5. Canonical NDJSON, redacted snippets (environment files can hold secrets), context packs: application overview (routes tree, feature areas), one card per project, one per service (its HTTP calls).

## 4. Fixtures (hand-written `expected.yml`, full precision and recall)

1. Standalone components with nested child components and `@if`/`@for`. 2. NgModule app with declarations and a shared module. 3. Services with `providedIn: 'root'`, constructor DI and `inject()`. 4. Providers: `useClass`, `useFactory`, `InjectionToken`. 5. Routes with children, lazy `loadComponent` and `loadChildren`, guards. 6. `HttpClient` calls with `environment.apiUrl` template literals and an interceptor prefix. 7. `proxy.conf.json` routing `/api` to a backend. 8. Template event and property bindings to methods. 9. Interface dispatch and abstract classes. 10. SignalR client. 11. NgRx action → effect → HTTP. 12. Environment file with secrets (must not leak). 13. Install failure (missing package) with syntax fallback. 14. Nx workspace with two apps and one library. 15. Two runs and amd64 vs arm64 byte-identical.

## 5. Gates

Same gate structure as dotnet-intelligence: Gate 1 infrastructure (image, Action, CI both architectures), Gate 2 contract v1.1 adoption (vendored schema, `verify`), Gate 3 extractor and adapters on fixtures, Gate 4 artifacts (index, query, context packs), Gate 5 validation on the lab Angular app (every HTTP call linked through federation to a Lifecycle endpoint) and on eShopOnAbp `apps/angular`, with ground truth written from source before the first run.
