<p align="center">
  <h1 align="center">iquantum</h1>
  <p align="center">
    An AI coding agent that plans before it acts, executes in an isolated sandbox,<br/>
    and only commits to your repository once every test passes.
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
  <a href="https://marketplace.visualstudio.com/items?itemName=iquantum.iquantum">
    <img src="https://img.shields.io/visual-studio-marketplace/v/iquantum.iquantum?label=VS%20Code%20Marketplace" alt="VS Code Marketplace" />
  </a>
  <img src="https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <a href="https://github.com/AyhamJo7/iquantum/pulls">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  </a>
</p>

---

## What is iquantum?

iquantum is an open-source AI coding agent you run from your terminal. You describe what you want, it writes a plan for you to review, then implements the change inside a private Docker sandbox, runs your tests, and — only if everything passes — commits the result to your Git repository.

**Your codebase is never touched until tests are green.**

The agent uses two AI models with separate roles:

- A **reasoning model** that thinks carefully and writes a step-by-step plan
- A **fast model** that reads the plan and generates the actual code changes

You review the plan before any code is written. You stay in control at every step.

---

## How it works

```
You type a task
      │
      ▼
┌─────────────────────────────────────┐
│  Plan                               │
│  AI reads your codebase and writes  │
│  a numbered step-by-step plan       │
└──────────────┬──────────────────────┘
               │  You approve or give feedback
               ▼
┌─────────────────────────────────────┐
│  Implement                          │
│  AI applies changes inside an       │
│  isolated Docker container          │
│  (your files are untouched)         │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Validate                           │
│  Your test suite runs in the        │
│  sandbox — same container,          │
│  real environment                   │
└──────────────┬──────────────────────┘
               │  Pass → commit to your repo
               │  Fail → retry implementation (up to MAX_RETRIES)
               ▼
         ✓  Committed
```

---

## Requirements

Before installing, make sure you have the following:

| Requirement | Notes |
|---|---|
| **npm** | Comes with [Node.js](https://nodejs.org/) — used only to install `iq` globally |
| **Docker** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) on macOS or Windows; [Docker Engine](https://docs.docker.com/engine/install/) on Linux |
| **An Anthropic API key** | Get one at [console.anthropic.com](https://console.anthropic.com) — you pay only for what you use |

> **Windows users:** run iquantum inside [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). Docker Desktop must have WSL2 integration enabled.

---

## Quick Start

### Step 1 — Install

```bash
npm install -g @iquantum/cli
```

This installs the `iq` command globally on your machine.

### Step 2 — Set up

```bash
iq
```

The first time you run `iq`, a short setup wizard appears. It asks for your Anthropic API key, saves your configuration, pulls the sandbox image, and starts the background daemon — all automatically.

### Step 3 — Start coding

Navigate to any project and type a task:

```bash
cd /path/to/your/project
iq
```

Then describe what you want in plain English:

```
> add input validation to the sign-up form
```

iquantum will plan it, show you the plan, wait for your approval, implement the changes, run your tests, and commit the result.

---

## The Interactive Interface

When you run `iq`, you enter the interactive REPL — a live terminal session where you and the agent collaborate. Here is what a typical exchange looks like:

```
you  add rate limiting to the login endpoint

PLAN ▸  ·  IMPLEMENT ○  ·  VALIDATE ○

⠸ Planning  3s

  1. Install express-rate-limit
  2. Create src/middleware/rateLimiter.ts (5 req / min)
  3. Mount the middleware before /auth routes in app.ts
  4. Add a test covering the 429 response

PLAN ✓  ·  IMPLEMENT ▸  ·  VALIDATE ○

⠹ Implementing  8s

┌─ src/middleware/rateLimiter.ts  +47 −0 ────────────────┐
    1  + import rateLimit from "express-rate-limit";
    2  + ...
└────────────────────────────────────────────────────────┘

PLAN ✓  ·  IMPLEMENT ✓  ·  VALIDATE ▸

⠼ Validating  2s

PLAN ✓  ·  IMPLEMENT ✓  ·  VALIDATE ✓

╭─ committed ────────────────────────────────╮
│  ✓  a3f8c12                                │
│     feat: add rate limiting to login       │
╰────────────────────────────────────────────╯

describe a task, or /help for commands
 iq v1.1.0  ·  claude-sonnet-4-6 ·  12k ▓▓▓░░░░░
```

The agent waits for your approval before writing a single line of code. If you are not happy with the plan, type `no` and explain what to change — the agent will revise and show you a new plan.

### Slash commands

Type any of these inside the `iq` REPL:

| Command | What it does |
|---|---|
| `/help` | Show all available commands |
| `/status` | Show session ID, active models, and token usage |
| `/model` | Show the reasoning and implementation models in use |
| `/plan` | Display the current plan (if one exists) |
| `/approve` | Approve the current plan without typing `yes` |
| `/reject <reason>` | Reject the plan and tell the agent why |
| `/compact` | Summarise and compress the context window to save tokens |
| `/clear` | Clear the visible transcript (session history is kept in the daemon) |
| `/mcp` | List connected MCP tools and their current status |
| `/restore [hash]` | Roll the sandbox back to a previous Git checkpoint |
| `/task <prompt>` | Start a PIV task in task mode |
| `/quit` | Exit the REPL — the daemon and sandbox stay running for resume |

### Keyboard shortcuts

| Shortcut | Effect |
|---|---|
| `Ctrl-O` | Toggle thinking / reasoning output visibility |
| `Ctrl-L` | Clear the screen |
| `Escape` | Cancel the current in-flight request |
| `Ctrl-C` twice | Exit `iq` immediately |

---

## Chat mode

For exploration without a plan/implement/validate loop, use:

```bash
iq chat
```

Chat mode keeps the same daemon-backed history and MCP tooling, but hides PIV-only UI and does not create commits.

The VS Code extension is available from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=iquantum.iquantum) for visual plan review and side-by-side diff approval inside the editor.

## Non-interactive mode

If you prefer to run a task from a script or another tool, use `iq task`:

```bash
iq task "refactor the database connection module to use a connection pool"
```

The agent will print the plan, prompt for approval interactively, then proceed. Use `--repo` to target a repository other than the current directory:

```bash
iq task --repo /path/to/project "add OpenAPI documentation to all routes"
```

---

## Daemon management

iquantum runs a small background daemon that manages your sessions and the Docker sandbox. You rarely need to touch it directly, but here are the commands:

```bash
iq daemon start    # Start the daemon in the background
iq daemon stop     # Gracefully stop the daemon
iq daemon status   # Check whether the daemon is running
```

The daemon starts automatically on first use and restarts automatically if it goes down.

---

## Configuration

### Viewing and changing your settings

```bash
iq config list                          # Show all saved settings (API key is redacted)
iq config get ANTHROPIC_API_KEY         # Read one value
iq config set IQUANTUM_ARCHITECT_MODEL claude-opus-4-7   # Change a value
```

Settings are saved in `~/.iquantum/config.json`. You can also set any of these as environment variables — environment variables always take priority over saved config.

### All configuration options

| Setting | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | For Anthropic | — | Your Anthropic API key; also used as the OpenAI-compatible fallback key when `IQUANTUM_API_KEY` is unset |
| `IQUANTUM_PROVIDER` | — | `anthropic` | AI provider route: `anthropic` or `openai` |
| `IQUANTUM_BASE_URL` | For `openai` | — | Base URL for an OpenAI-compatible endpoint, for example `https://api.deepseek.com` |
| `IQUANTUM_API_KEY` | For `openai`* | — | API key for the OpenAI-compatible endpoint; falls back to `ANTHROPIC_API_KEY` if omitted |
| `IQUANTUM_ARCHITECT_MODEL` | — | `claude-sonnet-4-6` | The reasoning model used to write plans |
| `IQUANTUM_EDITOR_MODEL` | — | `claude-haiku-4-5-20251001` | The fast model used to write code changes |
| `IQUANTUM_SANDBOX_IMAGE` | — | `ghcr.io/ayhamjo7/iquantum-sandbox:latest` | The Docker image used for the sandbox |
| `IQUANTUM_SOCKET` | — | `~/.iquantum/daemon.sock` | Unix socket path for CLI ↔ daemon communication |
| `IQUANTUM_TCP_PORT` | — | `51820` | Localhost TCP port used by the VS Code extension |
| `MAX_RETRIES` | — | `3` | How many times the agent retries before giving up |
| `IQUANTUM_EXEC_TIMEOUT_MS` | — | `120000` | How long (ms) a sandbox command can run before being killed |
| `IQUANTUM_MCP_SERVERS` | — | `[]` | External tools to expose to the agent via MCP (JSON array) |
| `LOG_LEVEL` | — | `info` | Daemon log verbosity: `error` · `warn` · `info` · `debug` |

\* When `IQUANTUM_PROVIDER=openai`, set either `IQUANTUM_API_KEY` or `ANTHROPIC_API_KEY`.

### Re-running the setup wizard

```bash
iq init
```

Run this any time you want to change your API key, swap models, or reset your configuration.

### Keeping iquantum up to date

```bash
iq update
```

---

## Contributing

Contributions are welcome from everyone — whether you are fixing a typo, reporting a bug, or building a new feature.

### Reporting a bug or requesting a feature

1. Open the [Issues tab](https://github.com/AyhamJo7/iquantum/issues)
2. Click **New issue**
3. Describe what you expected to happen and what actually happened
4. Include any error messages or steps to reproduce

### Contributing code — step by step

**1. Fork the repository**

Click **Fork** in the top-right corner of the GitHub page. This creates your own copy of the project under your account.

**2. Clone your fork**

```bash
git clone https://github.com/<your-username>/iquantum.git
cd iquantum
```

**3. Install dependencies**

You need [Bun](https://bun.sh) installed:

```bash
bun install
```

**4. Build the project**

```bash
bun run build
```

**5. Set up your local environment**

```bash
cp .env.example .env
```

Open `.env` and fill in your `ANTHROPIC_API_KEY`. For local sandbox development, build the image locally:

```bash
docker build -t iquantum/sandbox:local -f docker/sandbox.Dockerfile docker/
echo "IQUANTUM_SANDBOX_IMAGE=iquantum/sandbox:local" >> .env
```

Link the CLI so you can run `iq` from your local build:

```bash
bun link --cwd iquantum-cli
```

**6. Make your changes**

Work on your feature or fix. Run the checks frequently:

```bash
bun run test       # All tests must pass
bun run lint       # No lint warnings
bun run typecheck  # No type errors
```

**7. Commit your changes**

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```bash
git commit -m "feat(daemon): add session export command"
git commit -m "fix(cli): handle daemon restart gracefully"
git commit -m "docs: update configuration reference"
```

Commit prefixes: `feat` · `fix` · `chore` · `docs` · `test` · `refactor`

**8. Open a pull request**

Push your branch to your fork:

```bash
git push origin your-branch-name
```

Then go to the [original repository](https://github.com/AyhamJo7/iquantum) on GitHub. A banner will appear at the top offering to open a pull request from your branch. Click it, fill in a clear description of what you changed and why, and submit.

> **Tip:** For anything beyond a small bug fix or typo, open an issue first so we can discuss the approach before you invest time writing the code.

### What makes a good pull request

- A clear title that describes the change (`fix: handle empty repo map gracefully`)
- A description that explains *why* the change is needed, not just what it does
- All tests passing (`bun run test`)
- No lint errors (`bun run lint`)
- No type errors (`bun run typecheck`)
- One focused change per PR — avoid bundling unrelated fixes together

---

## Architecture

iquantum is a TypeScript monorepo built on [Bun](https://bun.sh):

```
iquantum/
├── iquantum-cli/      Terminal client — the iq command
├── iquantum-daemon/   Background agent runtime (HTTP + WebSocket over Unix socket)
└── packages/
    ├── config/        Environment config loader with runtime validation
    ├── types/         Shared TypeScript interfaces
    ├── llm/           AI provider abstraction (Anthropic + OpenAI-compatible)
    ├── repo-map/      AST-based repository map (tree-sitter + PageRank scoring)
    ├── sandbox/       Docker sandbox lifecycle management
    ├── diff-engine/   Unified diff parser and fuzzy hunk applicator
    ├── git/           Git checkpoint commits and sandbox restore
    ├── piv-engine/    Plan → Implement → Validate state machine
    ├── protocol/      CLI ↔ daemon message types
    └── context-window/  Token budget management
```

The CLI communicates with the daemon over a Unix socket (`~/.iquantum/daemon.sock`). The daemon manages all AI calls, sandbox containers, and SQLite state. The CLI renders the REPL and streams events back to the user in real time.

Sessions persist across daemon restarts via named Docker volumes (`iquantum-vol-<session-id>`). Your host filesystem is never written to until the sandbox's tests pass.

---

## Development commands

```bash
bun install              # Install all workspace dependencies
bun run build            # Compile all packages
bun run dev              # Start the daemon in watch mode (auto-restarts on save)
bun run test             # Run all tests
bun run test -- packages/diff-engine   # Run one package's tests
bun run lint             # Biome lint and format check
bun run typecheck        # TypeScript type check across all packages
```

---

## Roadmap

- [x] Interactive REPL with plan approval flow
- [x] Session resume — `iq` reconnects to the last session automatically
- [x] MCP tool integration — any stdio MCP server exposed as agent tools
- [x] Configurable sandbox exec timeout
- [x] First-run setup wizard
- [x] `/restore <hash>` — roll back to any prior Git checkpoint from the REPL
- [x] `iq chat` — conversational mode without the PIV loop
- [x] OpenAI-compatible provider routing — bring your own model (DeepSeek, Ollama, Together, …)
- [x] Polished terminal UI — PIV phase strip, live spinner, commit card, diff line numbers
- [ ] Multi-repo context spanning more than one repository
- [x] VS Code extension — visual diff approval and side-by-side plan review
- [ ] Cloud sandbox tier — hosted execution, zero local Docker setup

---

## License

[Apache 2.0](LICENSE) © [Ayham Joumran](https://github.com/AyhamJo7)
