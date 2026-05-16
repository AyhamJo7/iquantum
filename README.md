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
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" />
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
| [Node.js](https://nodejs.org/) / npm | current LTS (install-time package manager) |
| [Bun](https://bun.sh) | ≥ 1.3 |
| [Docker](https://www.docker.com/) | any recent version |
| Anthropic API key | BYOK |

> **Platform notes**: use Docker Desktop on macOS/Windows and Docker Engine on Linux.
> Windows users should run iquantum inside WSL2.

---

## Quick Start

### 1 — Install iquantum

```bash
npm install -g @iquantum/cli
```

### 2 — Run the first-time setup

```bash
iq
```

On first launch, iquantum opens a short setup wizard, saves
`~/.iquantum/config.json`, pulls the sandbox image automatically, starts the daemon, and
opens the interactive REPL.

### 3 — Run your first task

```bash
cd /path/to/your/project
iq task "your task description here"
```

Environment variables still work and always override saved config values, but installed
users do not need to create a `.env` file manually.

---

## Development / Contributing

To build iquantum from source:

```bash
git clone https://github.com/AyhamJo7/iquantum.git
cd iquantum
bun install
bun run build
docker build -t iquantum/sandbox:local -f docker/sandbox.Dockerfile docker/
cp .env.example .env
# Point the daemon at the locally-built image instead of the GHCR release:
echo "IQUANTUM_SANDBOX_IMAGE=iquantum/sandbox:local" >> .env
bun link --cwd iquantum-cli
```

For local development you can keep values in `.env`; export them before launching the daemon or CLI:

```env
ANTHROPIC_API_KEY=sk-ant-...
IQUANTUM_ARCHITECT_MODEL=claude-sonnet-4-6
IQUANTUM_EDITOR_MODEL=claude-haiku-4-5-20251001
IQUANTUM_SOCKET=~/.iquantum/daemon.sock
MAX_RETRIES=3
```

---

## CLI Reference

### `iq` (interactive REPL)

```bash
iq           # opens the interactive chat REPL
```

Resumes your last session automatically if the daemon still has it. Starts a fresh session otherwise. The REPL supports slash commands:

| Command | Effect |
|---|---|
| `/help` | List all available commands |
| `/clear` | Clear the transcript (session history stays in daemon) |
| `/compact` | Summarise and compress the context window |
| `/mcp` | List connected MCP tools and their status |
| `/restore [hash]` | Roll back the sandbox to a prior Git checkpoint |

Keyboard shortcuts: `Ctrl-O` toggles thinking output · `Ctrl-L` clears the screen · `Escape` cancels the current request · `Ctrl-C` twice exits.

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

### Setup, updates, and saved configuration

```bash
iq init                    Run the first-time setup wizard again
iq update                  Install the latest released version
iq config list             Show saved config values (API key redacted)
iq config get <KEY>        Read one saved config value
iq config set <KEY> <VAL>  Persist one saved config value
```

---

## Configuration Reference

Installed users are configured through `~/.iquantum/config.json`, which the first-run
wizard creates for you. You can edit it indirectly with `iq config list|get|set`.
Environment variables remain supported and win over saved values when both are present.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key |
| `IQUANTUM_ARCHITECT_MODEL` | — | `claude-sonnet-4-6` | Reasoning model used for planning |
| `IQUANTUM_EDITOR_MODEL` | — | `claude-haiku-4-5-20251001` | Fast model used for implementation |
| `IQUANTUM_SOCKET` | — | `~/.iquantum/daemon.sock` | Unix socket path for CLI ↔ daemon communication |
| `IQUANTUM_SANDBOX_IMAGE` | — | `ghcr.io/ayhamjo7/iquantum-sandbox:latest` | Sandbox image, pulled automatically when needed |
| `MAX_RETRIES` | — | `3` | Shared retry budget across plan rejections, diff failures, and validation failures |
| `IQUANTUM_EXEC_TIMEOUT_MS` | — | `120000` | Max duration (ms) for a sandbox command before the container is killed |
| `IQUANTUM_MCP_SERVERS` | — | `[]` | JSON array of MCP server configs to expose as agent tools |
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
| **MCP as external tool provider** | `IQUANTUM_MCP_SERVERS` accepts any stdio-transport MCP server. Tools are namespaced `serverName__toolName` and injected into the `iq` REPL tool loop. Servers are started lazily on first use and restarted on error. |
| **Dogfood validation** | No SWE-bench. iquantum is used to build iquantum. Real-world correctness over benchmark scores. |

---

## Roadmap

- [x] Session resume — `iq` auto-reconnects to the last session on startup
- [x] MCP tool integration — stdio MCP servers via `IQUANTUM_MCP_SERVERS`
- [x] Sandbox exec timeout — configurable kill-on-breach via `IQUANTUM_EXEC_TIMEOUT_MS`
- [ ] `iq restore <hash>` — roll back to any prior Git checkpoint from the CLI
- [ ] Multi-repo context — PageRank spanning more than one repository
- [ ] OpenAI-compatible provider routing — use DeepSeek V3 as the editor model
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

[Apache 2.0](LICENSE) © [Ayham Joumran](https://github.com/AyhamJo7)
