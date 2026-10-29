# Dependencies

Every dependency is pinned. Versions and licenses below come from `package-lock.json`, the `Dockerfile` and the CI workflow.

## Runtime (inside the image)

| Dependency | Version | License | Why |
|---|---|---|---|
| Node.js (`node:24-bookworm-slim`) | 24.22.2, digest `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` | MIT | runtime, type stripping, `node:sqlite` (SQLite 3.53.4 with FTS5) |
| `typescript` | 6.0.3 | Apache-2.0 | engine compiler when the repository has none usable (A3) |
| `@angular/compiler` | 22.2.3 | MIT | template parser when the repository has none usable (A4) |
| `tslib` | 2.8.1 | 0BSD | dependency of `@angular/compiler` |
| `yaml` | 2.9.1 | ISC | `config.yml` and fixture `expected.yml` |
| Debian `git` | 1:2.39.5-0+deb12u3 | GPL-2.0 | working copy export from Git objects |
| Debian `ca-certificates` | 20250419~deb12u2 | MPL-2.0 and others | TLS for package registries |

## Build and test only

| Dependency | Version | License |
|---|---|---|
| `@types/node` | 24.19.2 | MIT |
| `undici-types` | 7.24.6 | MIT (dependency of `@types/node`) |
| `rhysd/actionlint` image | 1.7.12, digest `sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667` | MIT |
| `actions/checkout` | v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`) | MIT |
| `actions/upload-artifact` | v7.0.2 (`cf430e030ddbb5b0abf93d22962f4752f3646cd9`) | MIT |
| `actions/download-artifact` | v8.0.2 (`9000827ccba6bdab643e8b6fd33ac0654aef8333`) | MIT |

## Repository dependencies

The analysed repository's own packages are installed into `/work` with scripts disabled (A5); the engine loads its `typescript` and `@angular/compiler` when their versions are supported (A3, A4) and never executes other repository code.

## Updating

Change the pin, rebuild, run `scripts/verify.sh` (all fixtures, two runs each), and let CI compare amd64 and arm64. A new Node digest or compiler version is a new image release.
