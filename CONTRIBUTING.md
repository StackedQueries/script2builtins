# Contributing to script2builtins

## Setup

```sh
npm install
npm run build
npm test
```

Node 18+. Pure TypeScript, no browser dependencies.

## Adding a new fingerprint API

Catalog entries live in `src/knowledge/<category>.ts`. The shape is:

```ts
{
  key: "navigator.someProp",       // or "*.someMethod" for wildcards
  category: "navigator",
  description: "what the API leaks",
  severity: "low" | "medium" | "high",
  botDetectionTell?: true,         // strong indicator
  evasion?: "how detector evasion patches handle this",
  argMatch?: ["2d", "webgl"],      // for methods like getContext
}
```

After adding:

1. `npm test` to confirm the matcher resolves it correctly.
2. If the key uses a new root identifier, add it to `watchedRoots()`
   in `src/knowledge/index.ts`.
3. Update the README's catalog summary if the category grew.

## Adding a new sink kind

Sinks live in `src/analyze/sinks.ts`. The `NetworkSinkKind` union in
`src/types.ts` lists them. To add one:

1. Append the kind to `NetworkSinkKind`.
2. Add a matcher in `scanSinks`.
3. Add a test in `test/sinks.test.ts`.

The runtime companion (`script2builtins-runtime`) reads
`NetworkSinkKind` and emits matching `RuntimeSinkEvent`s; if you add a
sink kind here, also add a corresponding wrapper in the runtime
trap script.

## Code style

- `"strict": true`, `"noUncheckedIndexedAccess": true`.
- One-paragraph header comment per module.
- JSDoc on every exported type and function.
- No magic numbers; name them.

## Pull requests

- Small, focused PRs.
- Tests for new behavior.
- Update `CHANGELOG.md` under `## Unreleased`.

## License

MIT, same as the project.
