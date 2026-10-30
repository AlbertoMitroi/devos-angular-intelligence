# Usage

**What it does:** exports the committed state from Git objects, discovers the Angular projects (`angular.json`, Nx `project.json`, package workspaces), installs dependencies without scripts into `/work` (package cache in `/cache`), builds one TypeScript program with type checker per project (parser-only fallback when install fails), and writes the graph, observations (components, DI, routes, templates, HTTP, SignalR, NgRx), links, redacted snippets, context packs, the SQLite index, `manifest.json` (written last, after validation against [contract v1.2](CONTRACT.md)) and `run.json`. `verify <generation>` repeats the checks. Install needs the network unless the cache already holds every package (`--offline`).

## GitHub Action

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
- id: intelligence
  uses: AlbertoMitroi/devos-angular-intelligence@v1
  with:
    fail-on: failed          # failed | partial | never
- uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  with:
    name: context
    path: ${{ steps.intelligence.outputs.generation-path }}
```

| Input | Default | Meaning |
|---|---|---|
| `path` | `.` | Repository to analyze, relative to the workspace |
| `project` | | Only this project (name from `angular.json` or `project.json`, or repository-relative path) |
| `config` | | Convention file (YAML), relative to the workspace |
| `output` | `intelligence-out` | Generation directory, relative to the workspace; must be absent or empty |
| `include-working-tree` | `false` | Analyze the working tree; the generation is marked `dirty` |
| `fail-on` | `failed` | When the step fails: `failed`, `partial` or `never` |

| Output | Meaning |
|---|---|
| `generation-path` | Generation directory, relative to the workspace |
| `manifest-path` | `manifest.json`, relative to the workspace; empty without a generation |
| `status` | `complete`, `partial` or `failed` |
| `coverage` | Compact JSON: `total`, `semantic`, `syntax`, `failed`, `notAnalyzed` |

- Docker container actions run only on Linux runners (amd64 or arm64).
- The package cache is `.angular-intelligence/` in the workspace; keep it between runs with `actions/cache`.
- The action image runs as root, as Docker container actions require (A14); the engine hands the output and cache directories back to the owner of the workspace.
- Diagnostics with severity warning or error appear as workflow annotations.

## Publishing the generation (OCI)

The engine never uploads anything. [`examples/workflows/analyze-and-push-oci.yml`](../examples/workflows/analyze-and-push-oci.yml) shows how a caller pushes each generation to a registry with ORAS. The layout is shared with dotnet-intelligence, so one consumer reads both:

| Part | Value |
|---|---|
| Reference | `ghcr.io/<owner>/context-<repository>:<commit sha>-angular`, plus the moving tag `main-angular`; lowercase. The engine suffix keeps two engines that analyze one repository at one commit from overwriting each other's tags. |
| Manifest `artifactType` | `application/vnd.devos.intelligence.generation.v1` |
| Layer | one file, `generation.tar.gz` (`org.opencontainers.image.title`), media type `application/vnd.devos.intelligence.generation.v1.tar+gzip`; the tar root is the generation directory (`./manifest.json`); entries sorted, mtime 0, owner and group 0, gzip without timestamp, so the same generation gives the same bytes |
| Layer annotation | `dev.devos.intelligence.manifest-sha256`: SHA-256 (lowercase hex) of `manifest.json` inside the tar |
| Manifest annotations | `org.opencontainers.image.source` (repository URL), `org.opencontainers.image.revision` (commit), `org.opencontainers.image.ref.name` (`refs/heads/main`), `dev.devos.intelligence.engine` (`angular-intelligence`); ORAS adds `org.opencontainers.image.created` |

The engine version is not an annotation: it is in `manifest.json`. A consumer pulls, checks the layer against `dev.devos.intelligence.manifest-sha256` and runs `verify` on the unpacked directory. GHCR creates a new package as private: pulling needs a token with `read:packages` until the owner makes the package public.

## docker run

```bash
mkdir -p intelligence-out
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/src:ro" -v "$PWD/intelligence-out:/out" -v angular-intelligence-cache:/cache \
  ghcr.io/albertomitroi/angular-intelligence:0.2.0 analyze --src /src --out /out
```

| Mount | Mode | Content |
|---|---|---|
| `/src` | read-only | The repository (a Git checkout; shallow clones work) |
| `/out` | read-write | The generation directory (absent or empty) |
| `/cache` | read-write, optional | Package manager caches (`npm`, `pnpm`, `yarn`, `corepack`) |
| `/work` | read-write | Exported working copy and `node_modules`; a tmpfs keeps the host disk clean (`--tmpfs /work:rw,exec,size=4g`) |
| `/config` | read-only, optional | Convention file passed with `--config` |

- `version --json` prints the engine version, Node, the engine's TypeScript and `@angular/compiler`, SQLite and FTS5, and the platform.
- `preflight --src <repo>` lists the projects found and the install plan without installing.
- `analyze` options: `--src`, `--out`, `--config`, `--project`, `--include-working-tree`, `--offline` (the package manager may use only the cache), `--no-install` (parser only).
- Private registries: pass the package manager's usual environment variables (for example `NPM_CONFIG_//registry.example/:_authToken`); tokens never appear in outputs or logs.
- `AI_IMAGE_DIGEST`: the image cannot know its own digest; pass it to have it recorded, otherwise the manifest says `unknown`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | complete |
| 10 | partial (a project fell back to the parser, or a stage reported partial results) |
| 20 | preflight blocked (reserved, shared with dotnet-intelligence; not emitted in 0.1.0) |
| 30 | nothing could be loaded (for example, `/src` is not a Git repository, or no project was found); no manifest |
| 40 | cancelled; no manifest |
| 50 | integrity check failed; no manifest |
| 1 | internal error (also: output directory not empty) |
| 2 | usage error |

`analyze` writes one JSON object per line on stdout: `run.start`, `stage.start` and `stage.end` (stages `export`, `discovery`, `preflight`, `install`, `load`, `extract`, `adapters`, `links`, `artifacts`), `diagnostic`, `run.end` (with `status` and `exitCode`). Logs go to stderr.

## Query

```bash
docker run --rm -v "$PWD/intelligence-out:/g:ro" ghcr.io/albertomitroi/angular-intelligence:0.2.0 query /g http --route /api
```

Subcommands: `symbol <name>`, `refs <id>`, `callers <id>`, `callees <id>`, `impl <id>`, `di <token>`, `routes`, `http [--route <prefix>]`, `search <text>` (FTS5), `dump` (canonical dump of the index). `--json` for machine output. Exit code 3: the name is ambiguous; 4: no results.

## Conventions (`config.yml`)

HTTP client wrappers that are not `HttpClient` are declared by the caller (A10):

```yaml
http:
  clients:
    - package: "@abp/ng.core"
      method: RestService.request
      request: { argument: 0, method: method, url: url }
      base: { argument: 1, property: apiName, environmentKey: "environment.apis.{}.url", default: default }
```

`{}` in `environmentKey` takes the value of `base.property`, or `default` when the call does not set it.
