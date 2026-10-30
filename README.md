# angular-intelligence

A context engine for Angular: given a repository at one commit, it produces a deterministic, verifiable generation (semantic graph with evidence, Angular observations, links, queryable index, context packs) in the shared [intelligence contract](docs/CONTRACT.md). Same shape as `dotnet-intelligence`: one Docker image, one GitHub Action.

**Status: Steps 1 to 4 in progress.** `analyze` exports the committed state, discovers `angular.json`, Nx and workspace projects, installs without scripts, builds a TypeScript program with type checker per project (parser-only fallback), and writes entities, declarations, references, calls and hierarchy with evidence; Angular observations for components, directives, pipes, modules, DI and providers, routes with lazy loading, templates, `HttpClient` with environment base URLs, interceptors and `proxy.conf`, SignalR and NgRx; links, redacted snippets, `index.sqlite`, context packs and a manifest validated against contract v1.1. `verify` and `query` read any generation. The 15 fixtures pass with hand-written expectations (`scripts/verify.sh`). Not yet: published image and CI run, eShopOnAbp validation report.

## Develop

Only Docker is needed.

```bash
scripts/verify.sh
```

`AI_VERIFY_ONLY=a06-http-env scripts/verify.sh` runs one fixture.

## Documents

- Plan and traceability: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Open questions: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)
- Contract: [docs/CONTRACT.md](docs/CONTRACT.md)
- Usage: [docs/USAGE.md](docs/USAGE.md)
- Dependencies and licenses: [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)
- Spikes: [docs/spikes/](docs/spikes/)
- Reports: [docs/reports/](docs/reports/)

## License

MIT, see [LICENSE](LICENSE).
