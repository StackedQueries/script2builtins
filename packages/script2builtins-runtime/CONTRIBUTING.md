# Contributing to script2builtins-runtime

Thanks for considering a contribution. This file covers the
mechanics; for the *why* behind design decisions, read
[`docs/design-review.md`](./docs/design-review.md).

## Local development

This package depends on the sibling `script2builtins` package. Until
both are on npm, set up local linking:

```sh
# In script2builtins:
cd ../script2builtins
npm install
npm run build
npm link

# In script2builtins-runtime:
cd ../script2builtins-runtime
npm install
npm link script2builtins
npx playwright install chromium
```

Once both are published, the `npm link` step disappears.

## Test layout

```
test/
  trap/                 unit tests on the trap-script generator
  runner/               unit tests on collect/merge/harness
  e2e/                  Playwright-driven end-to-end tests
```

Run everything:

```sh
npm test                  # all tests, including e2e (~5s, needs Chromium)
npx vitest run test/trap  # unit only, fast
```

## Adding a new fingerprint API

The catalog lives in the `script2builtins-knowledge` package — one
file per category at
`packages/script2builtins-knowledge/src/<category>.ts`. Add a new
`ApiDefinition` there. The runtime trap script picks it up
automatically on next build — no edits required here unless:

- the new entry is a property of a new root identifier (add it to
  `watchedRoots()` in `script2builtins-knowledge/src/index.ts`), or
- the new entry is a method on a prototype not yet in
  `WATCHED_PROTOTYPES` (add it in `src/trap/build.ts`).

After adding, run `npm test`. The trap-coverage tests will tell you
whether the entry is reachable.

## Code style

- TypeScript with `"strict": true` and `"noUncheckedIndexedAccess":
  true`. No `any` outside the trap-script source (which gets
  stringified into the browser and can't use TS types anyway).
- Modules have a one-paragraph header comment describing the job.
- Public types and functions have JSDoc. Internal helpers can omit.
- Hard caps and limits are named constants. No magic numbers.

## Phases and the roadmap

[`ROADMAP.md`](./ROADMAP.md) tracks phases. When picking up work:

1. Read the phase's row plus its open issues.
2. Mark the row in_progress, open a branch `phase-N-<slug>`.
3. Implement, test, update docs if behavior changed.
4. Mark the row completed.

New work that doesn't fit an existing phase goes into the "From the
review" table in `ROADMAP.md` with a new ID, target phase, and
one-line description.

## Reporting bugs

Use the issue templates in `.github/ISSUE_TEMPLATE/`. A bug report
needs:

- Trap script SHA-256 from your report (`report.trapScriptSha256`).
- Catalog version (`report.catalogVersion`).
- A minimal reproducer URL or HTML harness.
- Expected behavior vs observed.

## Pull requests

- Small focused PRs. One change per PR.
- Tests for new behavior (or a note in the PR description if it's
  inherently untestable, e.g. a fix for a real-world detector).
- Update `CHANGELOG.md` under `## Unreleased` with a one-line entry.
- Sign off with `Signed-off-by: <name> <email>` (DCO).

## License

By contributing you agree your contributions are licensed under the
MIT License, same as the rest of the project.
