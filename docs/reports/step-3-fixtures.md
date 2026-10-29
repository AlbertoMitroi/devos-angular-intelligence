# Step 3 gate: fixtures

**Result: 15 of 15 fixtures pass** on linux/arm64 (Docker Desktop on macOS), 2026-10-29, `scripts/verify.sh` at the engine state of commit `fa67ebb`. Not yet run: CI on amd64 and arm64 with the byte comparison between them (needs the GitHub repository).

## What verify.sh checked

1. Test stage: `tsc --noEmit` over the engine and 9 unit tests, 9 passed (including the vendored schema drift check, A7).
2. Image self-test: `"fts5":true`, Node `v24.22.2`, engine TypeScript `6.0.3`, `@angular/compiler` `22.2.3`, runtime user not root.
3. Each fixture exported to a Git repository with fixed dates, analysed twice (`/work` on tmpfs, shared `/cache`).
4. Per fixture: the two generations byte-identical except `run.json` and `index.sqlite`; the two `query dump` outputs of the index identical; `verify` ok; `tests/check-expected.ts` against the hand-written `expected.yml`: every item present and, for each declared kind or filter, nothing unexpected (full precision and recall).
5. GitHub Action mode on fixture 1: status `complete`, coverage `{"failed":0,"notAnalyzed":0,"semantic":1,"syntax":0,"total":1}`.

## Fixtures

| Fixture | Status | Entities | Relations | Observations | Links | Diagnostics |
|---|---|---|---|---|---|---|
| a01-standalone | complete | 27 | 59 | 6 | 3 | 0 |
| a02-ngmodule | complete | 55 | 79 | 11 | 2 | 0 |
| a03-services-di | complete | 29 | 59 | 7 | 4 | 0 |
| a04-providers | complete | 30 | 77 | 9 | 4 | 0 |
| a05-routes | complete | 30 | 70 | 12 | 0 | 0 |
| a06-http-env | complete | 42 | 76 | 16 | 2 | 0 |
| a07-proxy | complete | 22 | 43 | 7 | 2 | 0 |
| a08-template-bindings | complete | 21 | 39 | 1 | 0 | 0 |
| a09-dispatch | complete | 24 | 63 | 0 | 0 | 0 |
| a10-signalr | complete | 32 | 56 | 8 | 1 | 0 |
| a11-ngrx | complete | 57 | 130 | 12 | 5 | 0 |
| a12-secrets | complete | 23 | 37 | 9 | 1 | 0 |
| a13-install-failure | partial (exit 10) | 7 | 5 | 1 | 0 | 2 |
| a14-nx | complete | 17 | 42 | 5 | 2 | 0 |
| a15-determinism | complete | 11 | 16 | 1 | 0 | 0 |

Counts are from run 1 of each fixture (`graph/*.ndjson` line counts, `manifest.json` status). They include package entities and every relation kind, so they are larger than what each `expected.yml` declares.

## What the expectations caught

The expectations were written from the fixture sources before comparing. Four mismatches were engine bugs and were fixed in `fa67ebb`; one was an expectation error:

| Fixture | Mismatch | Cause | Fix |
|---|---|---|---|
| a06 | second `query dump` cut at 65 536 bytes | `process.exit()` right after a large write to a pipe | exit after stdout and stderr flush (A16) |
| a06 | `http.get(url)` gave `canonicalRoute: "/"`, `candidate` | an empty template became the root route | `null`, `urlTemplate: "{}"`, `unresolved` (A13) |
| a08 | `reset()` inside `@case` missing | `@switch` cases sit under `groups` since Angular 21 | the visitor walks `groups` (A4) |
| a12 | `'fixture-inline-secret-key-0042'` in `snippets.ndjson` and `index.sqlite` | `fallbackKey` not recognised as a secret key | names ending in `key` are secret (A6) |
| a14 | ids `ts:apps/admin:apps/admin/src/...` | expectation error: contract v1.1 defines the module path as repository-relative | `expected.yml` and A8 corrected |

After the eShopOnAbp run (Step 4 report), fixture 4 now expects the component's own provider as the single `exact` target, and fixture 8 contains an `<ng-container>`; `verify.sh` passed again with 15 of 15 fixtures and 10 of 10 unit tests on 2026-10-30.

## Not verified here

- amd64, and the amd64 versus arm64 byte comparison (CI).
- The published Action image (`ghcr.io/albertomitroi/angular-intelligence:0.1.0-action`); CI builds the action from the verified image.
- A real application: eShopOnAbp `apps/angular` is the Step 4 gate.
