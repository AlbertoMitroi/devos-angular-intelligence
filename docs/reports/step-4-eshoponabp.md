# Step 4 gate: eShopOnAbp apps/angular

**Result: 17 of 17 HTTP calls and 16 of 16 routes match the ground truth, with no unexpected ones.** Run on 2026-10-30, linux/arm64, image built from this branch. The repository is `abpframework/eShopOnAbp` at `7bfed7a322d16b34a5a66208c03486fa5dfacee9` (2025-01-08), the convention file is `tests/eshoponabp/config.yml` (A10), and the ground truth is `tests/eshoponabp/ground-truth.md` with its comparator input `tests/eshoponabp/expected.yml`, both committed before the first comparison (`390425d`, `e3143c1`).

## Commands

```bash
docker run --rm --tmpfs /work:rw,exec,size=6g -v ai-npm-cache:/cache -v "$REPO:/src:ro" -v "$OUT:/out" \
  -v "$PWD/tests/eshoponabp/config.yml:/config/config.yml:ro" angular-intelligence:verify \
  analyze --src /src --out /out --config /config/config.yml            # twice, OUT=out4 and out5
diff -r -x run.json -x index.sqlite out4 out5                         # identical
query <out> dump (both), cmp                                           # identical, 2 057 504 bytes in the earlier run pair
verify out4                                                            # ok
node tests/check-expected.ts tests/eshoponabp/expected.yml out4 0      # all items match
```

## Results (run out4)

| Item | Value |
|---|---|
| Exit code, status | 0, `complete` |
| Projects | 3 semantic (application `apps/angular`, libraries `catalog`, `ordering`), 0 syntax, 0 failed |
| Compilers | repository TypeScript 5.4.5 and `@angular/compiler` 18.1.5 in all three contexts (A3, A4) |
| Compilation errors in repository files | 0 per context |
| Install | `apps/angular`: `npm install --no-package-lock --ignore-scripts`, ERESOLVE, retried with `--legacy-peer-deps`, exit 0 (diagnostics `lockfile-missing`, `install-retried`) |
| Duration | 65 s first run (install 61 s), 17 s second run (warm cache) |
| Records | 606 entities, 1389 relations, 1459 evidence, 228 observations, 25 links, 2 diagnostics |
| Observations | `http.call` 17, `ui.route` 16, `ui.component` 10, `ui.uses_component` 22, `ui.uses_directive` 98, `ui.module` 17, `di.registers` 6, `di.consumes` 14, `config.key` 28 |
| Links | `renders` 11 exact; `consumes_contract` 5 exact, 9 unresolved (tokens from packages: `RestService` 3, `ConfirmationService` 2, `AuthService`, `EnvironmentService`, `UntypedFormBuilder`, `OAuthService`) |
| Context packs | `overview.md`, one per project, one per service with HTTP calls (`OrderService`, `ProductService`, `PublicProductService`) |

Every HTTP call is `candidate`, as the ground truth expects: `environment.apis.Catalog.url` and `environment.apis.Ordering.url` exist in `environment.ts` but not in `environment.prod.ts`, where ABP falls back to `apis.default` and merges a remote configuration at run time. The reason says so, for example: "environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts)".

## What the first runs found

| Finding | Kind | Fix |
|---|---|---|
| Install ran at the repository root (`yarn install` from the root `yarn.lock` of an unrelated one-dependency `package.json`), so the application had no `node_modules`; the engine fell back to its own compilers with 124 + 33 + 103 compilation errors | engine bug | install root is the nearest `package.json`, or an ancestor only when it declares the package as a workspace member; unit test added |
| `ProductComponent` also configured at `/ordering` | ground-truth error | `DashboardModule` imports `ProductRoutingModule`, so its `forChild` routes join the lazy `/ordering` module; added to the ground truth with a correction note (16 routes) |
| `<ng-container>` reported 12 times as an unresolved component | engine bug | Angular's built-in elements are never component uses; fixture 8 now has one |
| `ListService` consumers linked `ambiguous` to every component that provides it | precision gap | a component's own providers answer its injections first: `exact` to that registration (A11); fixture 4 changed accordingly |
| Reason said the key was missing in 2 environment files | wrong message | counts and names only the files that miss the key |

## Not verified

- amd64 and the published image (CI).
- Components, DI and template references beyond the counts above: the ground truth covers HTTP calls and routes only.
- The four ABP package route modules (`@abp/ng.account` and siblings): their routes live in `node_modules`, outside the repository, and are not analysed.
