# iquantum

An open-core AI coding agent that runs a hardcoded **Plan → Implement → Validate** loop inside an isolated Docker sandbox. Every successful validation auto-commits the changes to your local Git repository.

Built by synthesising the best ideas from [Aider](https://aider.chat) (AST repo mapping, Git-native speed), [Cline](https://github.com/cline/cline) (plan approval, visual safety), and [OpenHands](https://github.com/All-Hands-AI/OpenHands) (stateful sandboxed execution).

---

## How it works

```
you: iq task "add input validation to the signup form"

iquantum:
  1. Plan    — architect model maps the repo and writes PLAN.md
               → you read and approve (or reject with feedback)
  2. Implement — editor model generates a unified diff
               → applied inside an isolated Docker sandbox
  3. Validate  — your test suite runs in the sandbox
               → on pass: synced to host + auto-committed
               → on fail: loops back to Implement (up to 3 retries)
```

The sandbox is a named Docker volume seeded from your repo. It survives daemon restarts. Your host repo is never touched until validation passes.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- Docker (Docker Desktop with WSL2 backend on Windows)
- An Anthropic API key

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/AyhamJo7/iquantum.git
cd iquantum
bun install
```

### 2. Configure environment

Copy the example and fill in your keys:

```bash
cp .env.example .env
```

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
IQUANTUM_ARCHITECT_MODEL=claude-sonnet-4-5    # planning model (reasoning-capable)
IQUANTUM_EDITOR_MODEL=claude-haiku-4-5-20251001  # editing model (fast, cheap)
IQUANTUM_SOCKET=~/.iquantum/daemon.sock
MAX_RETRIES=3
```

### 3. Add the CLI to your PATH

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export PATH="$HOME/.bun/bin:$PATH"
```

Then link the CLI globally:

```bash
bun link --cwd iquantum-cli
```

Now `iq` is available anywhere.

### 4. Start the daemon

```bash
# Load your env vars, then:
iq daemon start

# Verify it's running:
iq daemon status
```

---

## Usage

### Run a task

```bash
cd /your/project

iq task "add pagination to the users list endpoint"
```

iquantum will:
- Build an AST repo map and send it to the architect model
- Stream the plan to your terminal
- Ask whether to approve, reject (with feedback), or quit
- If approved: implement in the sandbox, run tests, commit

### Daemon commands

```bash
iq daemon start   # start the daemon in the background
iq daemon stop    # send SIGTERM to the running daemon
iq daemon status  # check if the daemon is alive
```

### Task options

```bash
iq task --repo /path/to/repo "your prompt here"
```

By default `--repo` is the current working directory.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  iq (CLI)                                   │
│  Commander + readline                        │
│  HTTP + WebSocket over Unix socket           │
└────────────────┬────────────────────────────┘
                 │ ~/.iquantum/daemon.sock
┌────────────────▼────────────────────────────┐
│  iquantum-daemon                             │
│  Bun HTTP server + WebSocket fan-out         │
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
| `packages/types` | Shared TypeScript interfaces |
| `packages/config` | Zod-validated env config |
| `packages/repo-map` | tree-sitter AST → PageRank repo map |
| `packages/llm` | Anthropic + OpenAI-compatible providers, LLMRouter |
| `packages/sandbox` | Docker sandbox lifecycle, exec, sync |
| `packages/diff-engine` | Unified diff parse + fuzzy apply |
| `packages/git` | GitManager: checkpoint + restore |
| `packages/piv-engine` | PIVEngine state machine |
| `iquantum-daemon` | HTTP/WS daemon, SessionController, stores |
| `iquantum-cli` | `iq` CLI, DaemonClient, interactive task loop |

---

## Development

```bash
bun install          # install all workspace deps
bun run build        # compile all packages
bun run dev          # start daemon in watch mode
bun run test         # run all tests (Vitest)
bun run lint         # Biome check + format
bun run typecheck    # tsc --noEmit across all packages
```

Run a specific package's tests:

```bash
bun run test -- packages/diff-engine
```

---

## Project repo map self-check

The repo-map package has a self-map acceptance test (disabled in CI):

```bash
bun test packages/repo-map --test-name-pattern "self-map"
```

It verifies the map fits within 1000 tokens and contains the key exported symbols.

---

## Key design constraints

- **Fuzzy diff apply**: LLM diffs have off-by-one context lines. The apply layer uses Levenshtein distance with a ±5-line search window before rejecting a hunk.
- **Named sandbox volumes**: `iquantum-vol-<session-id>`. Anonymous volumes would not survive daemon restarts.
- **Shared retry budget**: A single counter across plan rejections, diff failures, and validation failures (default `MAX_RETRIES=3`). A reject counts against the same pool as implementation retries.
- **No SWE-bench**: Validation is dogfooding — iquantum is used to build iquantum.
- **MCP stubbed in v1**: The `IMcpClient` interface exists but no MCP servers ship in v1.

---

## Roadmap

- [ ] `iq restore <hash>` — roll back to any prior checkpoint
- [ ] Daemon restart recovery — resume live sessions after daemon restart
- [ ] Multi-repo context — PageRank spanning more than one repository
- [ ] OpenAI-compatible provider routing — use DeepSeek as the editor model
- [ ] MCP server integration — live docs, design tokens, external context
- [ ] VS Code extension — visual diff approval, side-by-side plan review
- [ ] Cloud sandbox tier — hosted Docker, no local setup required

---

## License

MIT
