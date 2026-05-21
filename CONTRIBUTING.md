# Contributing

Thanks for contributing to iquantum. This project is a Bun monorepo with a CLI,
daemon, and shared TypeScript packages.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies:

```bash
bun install
```

3. Run the main checks before opening a pull request:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Docker is required for sandbox integration tests.

## Repository Layout

- `iquantum-daemon/` contains persistence, orchestration, permissions, MCP, and streaming API code.
- `iquantum-cli/` contains the Ink REPL, slash commands, session resume, and terminal UI.
- `packages/` contains shared contracts and engines.

## Development Guidelines

- Keep package interfaces narrow and explicit.
- Follow existing TypeScript and Biome formatting patterns.
- Keep state transitions explicit and testable.
- Add or update tests for new behavior.
- For CLI components, use constants from `theme.ts` for colors, borders, spacing, and copy.
- Keep daemon, PIV runtime, sandbox, and host-sync boundaries intact.
- Preserve the architect/editor provider routing split.

## Testing

Use targeted tests while iterating:

```bash
bun run test packages/config
bun run test iquantum-cli/src/commands
```

Before submitting, run the full verification set:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

## Commit Messages

Use the existing conventional style:

- `feat(scope): add capability`
- `fix(scope): correct behavior`
- `docs: update guide`
- `chore: update tooling`

Do not mention Claude, AI, or Anthropic in commit messages or pull request titles.

## Pull Requests

Pull requests should include:

- A clear summary of user-visible impact.
- The implementation approach and any tradeoffs.
- Tests added or updated.
- Verification commands run locally.
- Screenshots or terminal output for user-facing CLI changes when useful.

Keep pull requests focused. Separate unrelated refactors from behavior changes.

