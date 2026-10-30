# Contract v1.2 adoption

**Result: the engine emits contract v1.2 (`schemaVersion` `1.2`); 15 of 15 fixtures, eShopOnAbp and lab-web match their expectations.** Recorded on 2026-10-30, linux/arm64, image built from branch `contract-v1-2`. Decision A17.

## Checks

| Check | Result |
|---|---|
| Vendored `schema/` = devos-intelligence-contract `v1.2.0` (`2828fd6`), 37 files | unit test, passes |
| `index.sqlite` tables = base section of `schema/index/v1/index.sql` | unit test on `sqlite_master`, passes |
| Unit tests | 11 of 11 |
| `scripts/verify.sh` | 15 of 15 fixtures: two identical runs, identical index dumps, `verify: ok`, every `expected.yml` item matches; GitHub Action mode `complete` |
| Kind schemas (`schema/v1/kinds`) | every observation of those kinds validates (`analyze` refuses to write a manifest otherwise); `verify` reports no kind outside the contract |
| `site` | present on every observation (the comparator reports any `1.2` observation without it); lab-web: 101 of 101 |
| Index meta | `commit`, `coverage`, `engine`, `indexSchema` `1`, `schemaVersion` `1.2`, `status` |
| eShopOnAbp `apps/angular` at `7bfed7a3` | two runs (56 s, 22 s) identical; `verify: ok`; 17 of 17 HTTP calls, 16 of 16 routes (`tests/eshoponabp/expected.yml`) |
| lab-web (`AlbertoMitroi/devos-lab-web`) at `66264d5` | two runs (17 s, 4 s) identical; `verify: ok`; `tests/lab-web/expected.yml` from its `ground-truth.yml`: 15 of 15 HTTP calls with routes and both configurations' base URLs, 12 of 12 routes, 15 of 15 component-to-service calls, the hub connection `/hubs/leasing` and both subscriptions |

## Changes in the expectations

- An observation's `at` is now its `site`. Components, directives and modules moved from the decorator line to the class name line (fixtures 1, 2, 8, 13, 14, 15 and the `renders` link targets); the NgRx reducer handler moved to the reducer's name (fixture 11). Multi-evidence items keep their full evidence under `evidenceAt` (fixtures 6, 7, 10, 11).
- Fixture 11 expects `pattern: notification` on sends and handlers.

## lab-web findings (fixed)

| v0.1.0 output | Ground truth | Fix |
|---|---|---|
| all 15 calls: "the base path differs between configurations" | both base URLs have an empty path | an empty common path is a valid base path |
| `realtime.connection` route null, `unresolved` | hub URL `{apiUrl}/hubs/leasing`; `hubPath` is `/hubs/leasing` in both configurations | an environment value identical in every configuration after the base becomes a literal (D20) |
| subscriptions: hub `unknown` | they use that hub | the connection comes from an injection-token factory; with one connection in the context, linked as `candidate` with a reason |

Not verified here: amd64 (CI), and the federation's use of `site` and the index (other sessions).
