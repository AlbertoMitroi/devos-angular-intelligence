# Step 2 gate: contract v1.1 adoption

**Result: adopted.** Recorded on 2026-10-29 with `scripts/verify.sh` (linux/arm64).

| Check | How | Result |
|---|---|---|
| Schema vendored, not edited | `schema/VENDOR.json` lists the SHA-256 of the 11 files of intelligence-contract `schema/v1` at `ea4975a9f9f1891a1951278a2facbb6d2260817b`; a unit test recomputes them | passes (test stage) |
| `schemaVersion` | manifest of every fixture generation | `1.1` |
| Every record validates | `analyze` validates before writing the manifest; `verify` repeats it | 15 of 15 fixtures `verify: ok` |
| Ids | `ts:{projectPath}:{modulePath}#{symbolPath}` with repository-relative paths (A8) | fixtures 1 to 15 match hand-written ids, including overloads (9), Nx projects (14) and non-ASCII names (15) |
| Configuration destinations (D20) | base URLs, proxy targets and hub URLs stored with `nameSource: configuration`; secrets absent | fixtures 6, 7, 10; fixture 12 checks 5 secret values absent from every output file, the index included |
| Kinds outside v1.1 (rule 4) | `verify` notes | nine kinds seen across the fixtures: `ui.directive`, `ui.module`, `ui.uses_directive`, `http.interceptor`, `http.proxy`, `realtime.connection`, `realtime.invoke`, `state.action`, link `renders` (A9; to propose to the contract owner) |

Not checked here: a consumer other than this engine's `verify` reading the generations (federation is outside Steps 1 to 4).
