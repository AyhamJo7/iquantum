<p align="center">
  <h1 align="center">iquantum</h1>
  <p align="center">
    An open-core AI coding agent with a hardcoded <strong>Plan → Implement → Validate</strong> loop.<br/>
    Every validated change is automatically committed to your Git repository.
  </p>
</p>

<p align="center">
  <a href="https://github.com/AyhamJo7/iquantum/actions/workflows/ci.yml">
    <img src="https://github.com/AyhamJo7/iquantum/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" />
  </a>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://bun.sh">
    <img src="https://img.shields.io/badge/Bun-%E2%89%A51.3-fbf0df?logo=bun&logoColor=black" alt="Bun ≥1.3" />
  </a>
  <img src="https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <a href="https://github.com/AyhamJo7/iquantum/pulls">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  </a>
</p>

---

## What is iquantum?

iquantum is a **headless AI coding agent** that combines the best ideas from the open-source ecosystem:

| Inspiration | What we took |
|---|---|
| [Aider](https://aider.chat) | AST repo mapping via tree-sitter, Git-native auto-commits |
| [Cline](https://github.com/cline/cline) | Human-in-the-loop plan approval before any code is written |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | Stateful Docker sandbox execution — your host is never touched |

The result is a **two-model loop**: a reasoning model writes a plan you review, a fast model implements it inside an isolated Docker container, your test suite validates the result, and only on a green build does the change land in your Git history.

---

## How it works

```
$ iq task "add rate limiting to the login endpoint"

── Planning ──────────────────────────────────────────────────────────
  [architect model streams plan...]

=== Plan ===

1. Add express-rate-limit as a dependency
2. Create src/middleware/rateLimiter.ts with a 5-req/min window
3. Mount the middleware in src/app.ts before the /auth routes
4. Add a test in tests/auth.test.ts covering the 429 response

Approve? [y]es / [n]o+feedback / [q]uit: y

── Implementing ──────────────────────────────────────────────────────
  [editor model generates unified diff, applied in sandbox]

── Validating ────────────────────────────────────────────────────────
  ✓ tests passed (attempt 1)

✓ Committed: a3f8c12
```

### The PIV loop

```
Plan          Implement        Validate
─────         ─────────        ────────
Architect  →  Editor model  →  bun test (in sandbox)
model         generates        ┌─ PASS → sync to host + git commit
writes        unified diff     └─ FAIL → back to Implement (≤ MAX_RETRIES)
PLAN.md       and applies
              it in Docker
```

The sandbox is a **named Docker volume** (`iquantum-vol-<session-id>`) seeded from your repo. It survives daemon restarts. Your host repo is untouched until tests pass.

---

## Requirements

| Requirement | Version |
|---|---|
| [Bun](https://bun.sh) | ≥ 1.3 |
| [Docker](https://www.docker.com/) | any recent version |
| Anthropic API key | BYOK |

> **Windows**: Docker Desktop with WSL2 backend is required.

---

## Quick Start

### 1 — Clone and install

```bash
git clone https://github.com/AyhamJo7/iquantum.git
cd iquantum
bun install
```

### 2 — Configure

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```env
ANTHROPIC_API_KEY=sk-ant-...
IQUANTUM_ARCHITECT_MODEL=claude-sonnet-4-5
IQUANTUM_EDITOR_MODEL=claude-haiku-4-5-20251001
IQUANTUM_SOCKET=~/.iquantum/daemon.sock
MAX_RETRIES=3
```

### 3 — Link the CLI globally

```bash
bun link --cwd iquantum-cli

# Add to your shell profile if not already set:
export PATH="$HOME/.bun/bin:$PATH"
```

### 4 — Start the daemon

```bash
source .env   # or use direnv

iq daemon start
iq daemon status   # → daemon is running (pid 12345)
```

### 5 — Run your first task

```bash
cd /path/to/your/project
iq task "your task description here"
```

---

## CLI Reference

### `iq task`

```
iq task [options] <prompt>

Options:
  --repo <path>   Target repository (default: current working directory)
```

| Prompt response | Effect |
|---|---|
| `y` / `yes` / Enter | Approve the plan → begin implementation |
| `n` / any other text | Reject → provide feedback → architect re-plans |
| `q` / `quit` | Abort and destroy the session |

### `iq daemon`

```
iq daemon start    Start the background daemon
iq daemon stop     Gracefully stop the daemon
iq daemon status   Check if the daemon is alive
```

---

## Configuration Reference

All configuration is via environment variables. Copy `.env.example` to `.env` — it is gitignored.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key |
| `IQUANTUM_ARCHITECT_MODEL` | ✅ | — | Reasoning model used for planning (e.g. `claude-sonnet-4-5`) |
| `IQUANTUM_EDITOR_MODEL` | ✅ | — | Fast model used for implementation (e.g. `claude-haiku-4-5-20251001`) |
| `IQUANTUM_SOCKET` | — | `~/.iquantum/daemon.sock` | Unix socket path for CLI ↔ daemon communication |
| `MAX_RETRIES` | — | `3` | Shared retry budget across plan rejections, diff failures, and validation failures |
| `LOG_LEVEL` | — | `info` | Daemon log level: `error` \| `warn` \| `info` \| `debug` |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  iq  (CLI)                                  │
│  Commander · readline                        │
│  HTTP + WebSocket over Unix socket           │
└────────────────┬────────────────────────────┘
                 │  ~/.iquantum/daemon.sock
┌────────────────▼────────────────────────────┐
│  iquantum-daemon                             │
│  Bun HTTP server · WebSocket fan-out         │
│  SQLite state (sessions, plans, messages)    │
│  SessionController → PIVEngine               │
└──────┬──────────────────────┬───────────────┘
       │                      │
┌──────▼──────┐   ┌───────────▼──────────────┐
│  LLM Router │   │  SandboxManager           │
│  Architect  │   │  Docker named volumes     │
│  Editor     │   │  Per-session containers   │
└──────┬──────┘   └───────────┬──────────────┘
       │                      │
       │              ┌───────▼──────────────┐
       │              │  DiffEngine           │
       │              │  Fuzzy unified-diff   │
       │              │  apply inside sandbox │
       │              └──────────────────────┘
┌──────▼───────────────────────────────────────┐
│  packages/                                    │
│  types · config · repo-map · llm              │
│  sandbox · diff-engine · git · piv-engine     │
└──────────────────────────────────────────────┘
```

### Package overview

| Package | Responsibility |
|---|---|
| `packages/types` | Shared TypeScript interfaces (Session, Plan, ValidateRun, …) |
| `packages/config` | Zod-validated env config loader |
| `packages/repo-map` | tree-sitter AST → PageRank-scored repo map |
| `packages/llm` | Anthropic + OpenAI-compatible providers, LLMRouter |
| `packages/sandbox` | Docker sandbox lifecycle, exec, host sync |
| `packages/diff-engine` | Unified diff parse + fuzzy hunk apply (Levenshtein, ±5-line window) |
| `packages/git` | GitManager: checkpoint commits and restore |
| `packages/piv-engine` | PIVEngine state machine |
| `iquantum-daemon` | HTTP/WS daemon, SessionController, SQLite stores |
| `iquantum-cli` | `iq` CLI, HttpDaemonClient, interactive task loop |

---

## Development

```bash
bun install              # install all workspace deps
bun run build            # compile all packages
bun run dev              # start daemon in watch mode
bun run test             # run all tests (Vitest)
bun run lint             # Biome check + format
bun run typecheck        # tsc --noEmit across all packages
```

**Run a single package's tests:**

```bash
bun run test -- packages/diff-engine
```

**Run the repo-map self-check** (disabled in CI — requires a real filesystem scan):

```bash
bun test packages/repo-map --test-name-pattern "self-map"
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Fuzzy diff apply** | LLM diffs routinely have off-by-one context lines. The apply layer uses Levenshtein distance with a ±5-line search window before rejecting a hunk rather than failing immediately. |
| **Named sandbox volumes** | `iquantum-vol-<session-id>` — named volumes survive daemon restarts. Anonymous volumes would lose sandbox state on shutdown. |
| **Shared retry budget** | A single `MAX_RETRIES` counter covers plan rejections, diff failures, and validation failures. A reject costs one retry from the same pool as implementation retries, keeping the ceiling simple and predictable. |
| **Two-model routing** | Architect and Editor models are configured and called separately — the separation is the core value proposition, not an implementation detail. |
| **MCP stubbed in v1** | The `IMcpClient` interface ships but no MCP servers are wired up. Stability of the PIV loop comes before external integrations. |
| **Dogfood validation** | No SWE-bench. iquantum is used to build iquantum. Real-world correctness over benchmark scores. |

---

## Roadmap

- [ ] `iq restore <hash>` — roll back to any prior Git checkpoint
- [ ] Daemon restart recovery — resume live sessions after a daemon crash
- [ ] Multi-repo context — PageRank spanning more than one repository
- [ ] OpenAI-compatible provider routing — use DeepSeek V3 as the editor model
- [ ] MCP server integration — live docs, design tokens, external context injection
- [ ] VS Code extension — visual diff approval, side-by-side plan review
- [ ] Cloud sandbox tier — hosted Docker, zero local setup required

---

## Contributing

Contributions are welcome. Please open an issue before submitting a pull request for anything non-trivial so we can align on direction first.

```bash
# Fork the repo, clone your fork, then:
bun install
bun run test       # must pass before opening a PR
bun run lint       # must be clean (no warnings)
bun run typecheck  # must pass
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope):`, `fix(scope):`, `chore:`, `docs:`, `test:`, `refactor:`.

---

## License

[MIT](LICENSE) © [Ayham Joumran](https://github.com/AyhamJo7)
