# script2builtins — workspace

This repository is the npm-workspace root for three packages:

| Package | Path | What it does |
|---|---|---|
| [`script2builtins-knowledge`](packages/script2builtins-knowledge) | `packages/script2builtins-knowledge` | Shared API catalog (`ALL_APIS`, `watchedRoots`, endpoint classifier) and the catalog-shape types (`ApiDefinition`, `Severity`, `SokLayer`). Versions and publishes independently so catalog updates don't require a static-analyzer release. |
| [`script2builtins`](packages/script2builtins) | `packages/script2builtins` | Static AST analyzer. Given a JS source string (curl dump, Playwright capture, etc.), reports which browser APIs and JS builtins it touches, plus network sinks, dynamic-execution hazards, and structural signatures. See [its README](packages/script2builtins/README.md). |
| [`script2builtins-runtime`](packages/script2builtins-runtime) | `packages/script2builtins-runtime` | Playwright-driven dynamic analyzer. Drives a real browser, traps every catalog API + sink + dynamic-execution point, and emits findings in the same shape as the static analyzer. See [its README](packages/script2builtins-runtime/README.md). |

## Development

```bash
# from the workspace root
npm install                  # bootstraps all three packages (creates symlinks under node_modules/)
npm run build                # tsc -p in every package
npm run typecheck            # tsc --noEmit in every package
npm test                     # vitest run in every package (knowledge: 5/5, s2b: 194/214 default-passing, runtime: 94/94)
```

Per-package scripts still work from `packages/<name>/`:

```bash
cd packages/script2builtins-runtime
npm run test:unit            # skip the Playwright E2E suite
npm run cli -- https://...   # run the CLI under tsx
```

To exercise the captured-fixture E2E gate (Google reCAPTCHA / DataDome /
Cloudflare Turnstile blobs):

```bash
cd packages/script2builtins
S2B_RUN_E2E=1 npx vitest run test/fixtures-captured.test.ts
```

## License

MIT. See [`LICENSE`](LICENSE).
