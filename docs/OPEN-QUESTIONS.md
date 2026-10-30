# Open questions

Questions that need the owner or the contract owner. Each names what is blocked and the current behaviour.

1. **Kinds outside contract v1.1 (A9).** Resolved: contract v1.2.0 (C4) accepts them; the engine emits `schemaVersion` `1.2` (A17).
2. **Actions emitted by NgRx effects.** An effect that maps to another action (fixture 11: `load$` emits `ordersLoaded`) is not recorded as an `inprocess.send`, so there is no `dispatches_to` link from the effect to the reducer. The plan asks only for the actions an effect reacts to and its HTTP calls. Add it?
3. **Syntax mode coverage.** Without installed dependencies (fixture 13) the parser-only context keeps entities, contains, inherits, components and template references; DI, routes, HTTP, SignalR and NgRx need the checker and are not emitted. The `syntax-fallback` diagnostic and the context load mode say so; there is no per-adapter diagnostic. Is that enough?
4. **Same-origin calls.** A relative URL with no interceptor and no proxy rule (fixture 7, `/health`) has `baseAddress: null` and resolution `exact`: the base is the origin that served the application, which the repository does not name. Linking such calls to a backend needs deployment topology, outside Step 4.
