# Contributing

Thanks for your interest in umm-actually! It's a single-purpose GitHub Action,
so the contribution loop is simple.

## What this is

A Docker-based GitHub Action that reviews pull requests with an LLM via
[OpenRouter](https://openrouter.ai) and posts one consolidated PR review with
inline findings. TypeScript inside, Node 24, strict mode throughout.

## Prerequisites

- Node.js 24 (an `.nvmrc` is provided — `nvm use`)
- Docker (for the image build check)

**Windows:** this repo uses symlinks (`CLAUDE.md → AGENTS.md`). Run
`git config core.symlinks true` before cloning, or re-clone after setting
it — otherwise Git checks out symlinks as plain text files containing the
target path.

## Build & test

```bash
npm ci
npm test              # vitest — the full unit suite
npm run lint          # eslint (typescript-eslint strict)
npm run prettier:check
npm run build         # tsc
docker build .        # what CI's smoke step runs
```

All of these must pass before pushing — CI runs the same steps.

## Code conventions

Conventions live in [AGENTS.md](./AGENTS.md) — the single source of truth. Key
points:

- Functional style, immutable by default; no `any`, no `as`, no `!` — runtime
  guards and Zod narrowing instead
- Pure modules (`diff/`, `review/`) never import I/O modules; only `main.ts`
  touches `process.env` and constructs SDK clients
- Use the official SDKs (`@actions/core`, `@actions/github`,
  `@openrouter/sdk`, `parse-diff`) — don't hand-roll what they already do
- Relative imports carry explicit `.js` extensions (ESM runtime requirement)
- Tests are behavioral specs: one focused `it()` per behavior, exact
  assertions, `const` per test

## Pull request process

1. **Branch from `main`** with a descriptive prefix (`feat/`, `fix/`, `docs/`,
   `ci/`, `chore/`)
2. **Keep PRs focused** — one logical change per PR
3. **Run the full local check** (test, lint, format, build, docker build)
   before pushing
4. **Use a Conventional Commit PR title** (`feat: …`, `fix: …`) — PRs are
   squash-merged and the title becomes the changelog entry
5. **Required checks must pass** — the CI workflow runs format, lint, tests,
   build, and a Docker build smoke step

## Issues

- **Bug reports** and **feature requests**: open a GitHub issue
- **Security issues**: see [SECURITY.md](./SECURITY.md) — report privately,
  not as a public issue

## Releases

Releases are cut by the maintainer with the Manual Release workflow, which
bumps the version and pushes a `vX.Y.Z` tag. The Release workflow then
publishes the action's Docker image, pins the tag to it, creates the GitHub
Release, and updates [`CHANGELOG.md`](./CHANGELOG.md) from Conventional
Commit messages — which is why PR titles matter: on a squash merge the title
becomes the changelog entry.

Every Release step is idempotent. If a run stops part-way, dispatch the
Release workflow with the tag as input and it finishes what is missing.

## License

[MIT](./LICENSE). By contributing, you agree your contributions are licensed
under the MIT License.
