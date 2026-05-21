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

| Requirement | Version | How to install |
|---|---|---|
| **Bun** | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| **npm** | any | Comes with [Node.js](https://nodejs.org/) |
| **Docker** | any | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux) |
| **Anthropic API key** | — | Create one at [console.anthropic.com](https://console.anthropic.com/) |

> **Windows users:** run iquantum inside [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). Docker Desktop must have WSL2 integration enabled.

> **OpenAI-compatible providers:** If you prefer DeepSeek, Ollama, or another OpenAI-compatible endpoint, see the [Configuration](#configuration) section — no Anthropic key required.

---

## Quick Start

### 1. Install

```bash
npm install -g @iquantum/cli
```

This installs the `iq` command globally. The CLI itself uses Bun at runtime — confirm both are available before continuing:

```bash
bun --version   # should print 1.3 or later
iq --version    # should print 3.x.x
```

### 2. First-time setup

Navigate to a Git repository you want to work in, then run:

```bash
cd /path/to/your/project   # must be a Git repo
iq
```

The first time you run `iq`, a short setup wizard appears and asks for your **Anthropic API key** (find it at [console.anthropic.com](https://console.anthropic.com/) → API Keys). It saves your key, pulls the sandbox image from `ghcr.io`, and starts the background daemon — all automatically. This takes about 30 seconds on first run while Docker pulls the image.

> **Tip:** you can re-run the wizard any time with `iq init` to change your key or swap models.

### 3. Describe a task

Once inside the REPL, type what you want in plain English:

```
> add input validation to the sign-up form
```

The agent will write a numbered plan. **Read it, then either approve or guide it:**

```
> yes                         ← approve and proceed
> no, also handle null emails  ← reject and give feedback; agent revises the plan
```

After approval, the agent implements the changes in the sandbox, runs your tests, and commits the result. You can start your next task immediately.

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
 iq v4.0.0-alpha.2  ·  claude-sonnet-4-6 ·  12k ▓▓▓░░░░░
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
| `/remember <fact>` | Save a project memory |
| `/memory` | List, pin, or forget saved memories |
| `/doctor` | Run local diagnostics |
| `/context` | Show the current context budget |
| `/diff` | Show the current sandbox diff |
| `/export` | Export the current session |
| `/agents` | List child agents for the current coordinator session |
| `/fast` | Switch to fast effort |
| `/normal` | Switch to normal effort |
| `/thorough` | Switch to thorough effort |
| `/hooks` | List loaded hooks |
| `/skills` | List built-in and custom skills |
| `/keybindings` | Show active keybindings |
| `/snapshots` | List file snapshots for the current session; restore to a named snapshot |
| `/review` | Review staged changes, a commit, path, or pull request |
| `/quit` | Exit the REPL — the daemon and sandbox stay running for resume |

### Keyboard shortcuts

| Shortcut | Effect |
|---|---|
| `Ctrl-O` | Toggle thinking / reasoning output visibility |
| `Ctrl-L` | Clear the screen |
| `Escape` | Cancel the current in-flight request |
| `Ctrl-C` twice | Exit `iq` immediately |

---

## CLI commands

| Command | What it does |
|---|---|
| `iq` | Open the interactive PIV REPL (auto-starts daemon if not running) |
| `iq chat` | Open chat mode without the PIV loop (auto-starts daemon) |
| `iq task <prompt>` | Run one PIV task non-interactively (daemon must be running) |
| `iq task --coordinator <prompt>` | Decompose a large task into parallel worker agents |
| `iq review` | Review staged changes by default |
| `iq review --commit <ref>` | Review one commit |
| `iq review --path <path>` | Review a path against `HEAD` |
| `iq review --pr <number-or-url>` | Review a GitHub pull request |
| `iq doctor` | Check Docker, config, daemon reachability, and API key setup |
| `iq config list|get|set` | Read and write local configuration |
| `iq daemon start|stop|status` | Manage the background daemon |
| `iq init` | Re-run setup and scaffold hooks, skills, and keybindings |
| `iq update` | Update the installed CLI |

---

## Chat mode

For exploration without a plan/implement/validate loop, use:

```bash
iq chat
```

Chat mode keeps the same daemon-backed history and MCP tooling, but hides PIV-only UI and does not create commits.

The VS Code extension is available from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=iquantum.iquantum) for visual plan review and side-by-side diff approval inside the editor.

## Non-interactive mode

`iq task` runs a single PIV task from the command line without opening the REPL. The daemon must already be running — start it first if needed:

```bash
iq daemon start
iq task "refactor the database connection module to use a connection pool"
```

The agent will print the plan, prompt for approval interactively, then proceed.

Use `--repo` to target a repository other than the current directory:

```bash
iq task --repo /path/to/project "add OpenAPI documentation to all routes"
```

Use `--extra-repo` (repeatable) to pull in context from additional repositories when the task spans more than one codebase:

```bash
iq task --repo /path/to/server --extra-repo /path/to/shared-lib "update the API to match the types in shared-lib"
```

Use `--worktree` to run the task on a dedicated Git worktree branch — useful when you have uncommitted changes on your current branch and do not want the agent to touch them:

```bash
iq task --worktree "upgrade the auth flow without touching my current checkout"
```

## Agent Orchestration

For large tasks with separable workstreams, run coordinator mode:

```bash
iq task --coordinator "build a REST API and write tests for it"
```

The coordinator asks the Architect model for a worker manifest, spawns child agents on dedicated worktree branches, waits for their PIV loops to complete, applies their validated diffs into the coordinator sandbox, runs the coordinator test command, and commits the integrated result if validation passes.

In the REPL, agent activity appears in the `AgentRoster` panel below the PIV phase strip. It shows each child agent's name, current phase, turn progress, and status. Spawn and failure frames render as transcript cards, and `/agents` lists the current child sessions with their status.

Chat/tool mode can also use the built-in agent tools:

| Tool | Purpose |
|---|---|
| `agent_spawn` | Start a child agent from an `AgentManifest` |
| `agent_list` | Return the current coordinator's child agents |
| `agent_task` | Submit a follow-up PIV task to a named child agent |
| `agent_wait` | Wait for a named child to finish or fail |
| `agent_kill` | Stop a named child agent |

---

## Daemon management

iquantum runs a small background daemon that manages your sessions and the Docker sandbox.

**`iq` and `iq chat` start the daemon automatically** if it is not already running — you do not need to manage it for interactive use.

**`iq task` requires the daemon to be running first.** If you see a connection error with `iq task`, run `iq daemon start` once and retry.

```bash
iq daemon start    # Start the daemon in the background
iq daemon stop     # Gracefully stop the daemon
iq daemon status   # Check whether the daemon is running
```

The daemon persists state to `~/.iquantum/` between restarts. Sessions, memories, and sandbox volumes survive a daemon restart — you can pick up where you left off.

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
| `IQUANTUM_CORS_ORIGINS` | For browser clients | — | Comma-separated browser origins allowed to call the cloud TCP API |
| `MAX_RETRIES` | — | `3` | How many times the agent retries before giving up |
| `IQUANTUM_EXEC_TIMEOUT_MS` | — | `120000` | How long (ms) a sandbox command can run before being killed |
| `IQUANTUM_MCP_SERVERS` | — | `[]` | External tools to expose to the agent via MCP (JSON array) |
| `IQUANTUM_MEMORY_TOKENS` | — | `2000` | Token budget reserved for injected memories |
| `IQUANTUM_AUTO_MEMORY` | — | `false` | Enable automatic memory extraction |
| `IQUANTUM_AUTO_MEMORY_MAX` | — | `5` | Maximum number of memories to extract per automatic run |
| `IQUANTUM_AUTO_MEMORY_MODEL` | — | Architect model | Optional model override for automatic memory extraction |
| `IQUANTUM_MEMORY_RANKING` | — | `true` | Rank memories by relevance before injecting into context |
| `IQUANTUM_MEMORY_RANKING_MODEL` | — | Architect model | Optional model override for memory ranking |
| `IQUANTUM_FILE_TOOLS` | — | `true` | Enable built-in file read/write/edit/glob/grep tools |
| `IQUANTUM_FILE_TOOL_MAX_BYTES` | — | `10485760` | Maximum bytes returned by one file tool read |
| `IQUANTUM_WEB_TOOLS` | — | `false` | Enable built-in web search and fetch tools |
| `IQUANTUM_SEARCH_PROVIDER` | For web search | `brave` | Search provider: `brave` or `tavily` |
| `BRAVE_API_KEY` | For Brave search | — | Brave Search API key |
| `TAVILY_API_KEY` | For Tavily search | — | Tavily API key |
| `IQUANTUM_HOOKS_DIR` | — | `~/.iquantum/hooks` | Directory for hot-loaded hooks |
| `IQUANTUM_HOOK_TIMEOUT_MS` | — | `5000` | Maximum duration for one hook run |
| `IQUANTUM_SKILLS_DIR` | — | `~/.iquantum/skills` | Directory for hot-loaded custom skills |
| `IQUANTUM_KEYBINDINGS_FILE` | — | `~/.iquantum/keybindings.json` | REPL keybinding map |
| `IQUANTUM_REVIEW_MODEL` | — | Architect model | Optional model override for `iq review` |
| `IQUANTUM_COMPACTION_AUTO_THRESHOLD` | — | `0.8` | Fraction of context budget used that triggers automatic compaction |
| `IQUANTUM_COMPACTION_KEEP_TURNS` | — | `8` | Number of most-recent turns to keep verbatim after compaction |
| `IQUANTUM_COMPACTION_SUMMARY_TOKENS` | — | `4000` | Token budget for the compaction summary block |
| `IQUANTUM_SNAPSHOTS` | — | `true` | Enable automatic file snapshots on each turn |
| `IQUANTUM_SNAPSHOT_MAX_TURNS` | — | `100` | Maximum number of snapshots retained per session |
| `IQUANTUM_MAX_AGENTS` | — | `4` | Maximum number of child agents allowed per coordinator session |
| `IQUANTUM_AGENT_MAX_TURNS` | — | `50` | Default maximum PIV turns for each child agent |
| `IQUANTUM_AGENT_TIMEOUT_MS` | — | `1800000` | How long (ms) to wait for a child agent before marking it as failed |
| `IQUANTUM_APPROVAL_MODE` | — | `cli` | How plan approval is handled: `cli` (interactive) · `webhook` · `slack` · `auto` |
| `IQUANTUM_APPROVAL_WEBHOOK_URL` | For `webhook` mode | — | URL that receives approval request payloads |
| `IQUANTUM_APPROVAL_WEBHOOK_SECRET` | For `webhook` mode | — | HMAC secret for webhook request signing |
| `IQUANTUM_APPROVAL_TIMEOUT_MS` | — | `1800000` | How long (ms) to wait for an external approval before timing out |
| `IQUANTUM_SLACK_TOKEN` | For `slack` mode | — | Slack bot token |
| `IQUANTUM_SLACK_CHANNEL` | For `slack` mode | — | Slack channel ID for approval messages |
| `IQUANTUM_SLACK_APPROVAL_WEBHOOK` | For `slack` mode | — | Slack incoming webhook URL for approval notifications |
| `IQUANTUM_SANDBOX_CPU_SHARES` | — | `1024` | CPU shares assigned to each sandbox container (relative weight) |
| `IQUANTUM_SANDBOX_MEMORY_LIMIT_MB` | — | `2048` | Memory limit per sandbox container in megabytes |
| `IQUANTUM_SANDBOX_NETWORK` | — | `none` | Sandbox network mode: `none` · `bridge` · `host` |
| `IQUANTUM_SANDBOX_UPSTREAM_PROXY` | — | `false` | Forward sandbox traffic through the host's proxy settings |
| `SENTRY_DSN` | For production monitoring | — | Optional Sentry DSN used to capture daemon request and process errors |
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

## Memory System

Save durable project facts with `/remember`:

```text
/remember this repo uses Biome and Bun workspaces
```

Use `/memory` to list memories, `/memory pin <name>` to keep an item in the active context, and `/memory forget <name>` to remove it. Memories are persisted by the daemon and materialized into `~/.iquantum/MEMORY.md` so they survive daemon restarts and new sessions. `IQUANTUM_MEMORY_TOKENS` controls the memory context budget, and `IQUANTUM_AUTO_MEMORY=true` enables automatic memory extraction from conversations.

---

## File Tools

When `IQUANTUM_FILE_TOOLS=true` (the default), the agent can use built-in repository tools without an external MCP server:

| Tool | Purpose |
|---|---|
| `file_read` | Read text files inside the allowed repository roots |
| `file_write` | Create or replace a file |
| `file_edit` | Apply targeted edits using the diff engine |
| `file_glob` | Find files by glob pattern |
| `file_grep` | Search file contents |

All file paths are sanitized and resolved under the session repositories. `IQUANTUM_FILE_TOOL_MAX_BYTES` limits the bytes returned by a single read.

---

## Web Tools

Web tools are opt-in. To enable them, add the following to `~/.iquantum/config.json` or set as environment variables:

```bash
iq config set IQUANTUM_WEB_TOOLS true
iq config set IQUANTUM_SEARCH_PROVIDER brave
iq config set BRAVE_API_KEY <your-key>
```

Get a Brave Search API key at [brave.com/search/api](https://brave.com/search/api/) — there is a free tier. To use Tavily instead, set `IQUANTUM_SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY`.

`web_search` returns search results; `web_fetch` fetches and converts pages to readable text. Fetches are protected by SSRF checks that block localhost, private IP ranges, and redirect chains into private networks.

---

## Diagnostics

Run `iq doctor` to check your local setup before starting a session:

```bash
iq doctor
```

Example output:

```text
ok    Docker daemon    running
ok    Config file      loaded
ok    API key          present
ok    Daemon socket    reachable at ~/.iquantum/daemon.sock
warn  Sandbox image    ghcr.io/ayhamjo7/iquantum-sandbox:latest not found locally
```

If you see a `warn Sandbox image` line, the image will be pulled automatically on your next `iq` run — no action needed. For any `fail` line, the message describes what to fix (missing key, Docker not running, etc.).

Inside the REPL, `/doctor` runs the same checks without leaving the session.

---

## Context Budget

Use `/context` to inspect the active context window: message tokens, repo-map tokens, memory tokens, and remaining budget. Use `/compact` when the conversation is long; the daemon writes a summary and keeps the session moving with less prompt weight.

`/diff` shows the current sandbox diff, and `/export` writes a session transcript in markdown or JSON.

---

## Code Review

`iq review` runs the review engine without starting a full PIV implementation:

```bash
iq review                         # staged changes
iq review --commit HEAD~1         # one commit
iq review --path src/auth.ts      # path compared with HEAD
iq review --pr 123                # GitHub PR number or URL
```

Inside the REPL, use `/review staged`, `/review commit <ref>`, `/review path <path>`, or `/review pr <number-or-url>`.

---

## Effort Levels

Effort changes how the daemon routes model calls:

| Level | Command | Route |
|---|---|---|
| Fast | `/fast` or `iq task --effort fast` | Editor model |
| Normal | `/normal` or `iq task --effort normal` | Architect model |
| Thorough | `/thorough` or `iq task --effort thorough` | Dedicated thorough route when configured, otherwise architect |

The default is normal. Keep `IQUANTUM_ARCHITECT_MODEL` and `IQUANTUM_EDITOR_MODEL` separate; the planning/editing split is part of the runtime design.

---

## Hooks

Hooks are loaded from `IQUANTUM_HOOKS_DIR` (default `~/.iquantum/hooks`) and reloaded while the CLI is running. Shell hooks use a first-line event subscription and receive the event JSON on stdin:

```bash
#!/usr/bin/env bash
# events: pre_apply_diff,post_validate

event="$(cat)"
case "$event" in
  *\"pre_apply_diff\"*) echo '{"block": false, "message": "diff accepted"}' ;;
  *) echo '{"block": false}' ;;
esac
```

JavaScript and TypeScript hooks export `{ name, events, run }`. Every hook is bounded by `IQUANTUM_HOOK_TIMEOUT_MS`; timeout failures are logged and do not block the session.

Hook events: `pre_tool_call`, `post_tool_call`, `pre_apply_diff`, `post_validate`, `on_permission_request`, `session_created`, `session_destroyed`, `plan_generated`, `plan_approved`, `plan_rejected`, `checkpoint_created`, `task_started`, `task_completed`.

---

## Skills

Skills are custom slash commands loaded from `IQUANTUM_SKILLS_DIR` (default `~/.iquantum/skills`) and hot-reloaded by the CLI. A JavaScript skill exports a default object:

```js
export default {
  name: "ticket",
  description: "Start work from an issue ID",
  async run(args, ctx) {
    await ctx.client.postMessage(ctx.sessionId, `Load issue ${args}`);
    ctx.dispatch({ type: "system_message", text: `Loaded ${args}`, level: "info" });
  },
};
```

Built-in skills: `batch`, `debug`, `export`, and `doctor`. Use `/skills` to see the active set.

---

## Keybindings

Custom keybindings are read from `IQUANTUM_KEYBINDINGS_FILE` (default `~/.iquantum/keybindings.json`). Chords map to built-in actions or `run:<slash-command>`:

```json
{
  "ctrl+k ctrl+c": "compact",
  "ctrl+k ctrl+s": "status",
  "ctrl+k ctrl+d": "doctor",
  "ctrl+e": "export",
  "ctrl+r": "run:review"
}
```

Default bindings created by `iq init`: `ctrl+k ctrl+c` for compact, `ctrl+k ctrl+s` for status, `ctrl+k ctrl+d` for doctor, and `ctrl+e` for export.

---

## Worktree Mode

Use `--worktree` when you want the agent to work on a completely separate branch without touching your current checkout:

```bash
# Your current branch has WIP changes you don't want the agent to touch.
# --worktree creates iquantum/<session-id> as a sibling worktree directory.
iq task --worktree "migrate the ORM from Sequelize to Drizzle"
```

The agent's commits land on the session branch. When the session is destroyed, the worktree directory is removed automatically. The branch and its commits remain — merge them in whenever you are ready.

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

Bundle and link the CLI so you can run `iq` from your local build:

```bash
bun run build:dist
cd iquantum-cli && bun link && cd ..
```

> **Note:** `bun link` must be run from inside the `iquantum-cli/` directory after `build:dist` so the symlink points to the compiled bundle.

To produce the same artifact that is published to npm:

```bash
npm pack ./iquantum-cli
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
├── iquantum-vscode/   VS Code extension
└── packages/
    ├── config/        Environment config loader with runtime validation
    ├── types/         Shared TypeScript interfaces
    ├── llm/           AI provider abstraction (Anthropic + OpenAI-compatible)
    ├── repo-map/      AST-based repository map (tree-sitter + PageRank scoring)
    ├── sandbox/       Docker sandbox lifecycle management
    ├── diff-engine/   Unified diff parser and fuzzy hunk applicator
    ├── git/           Git checkpoint commits and sandbox restore
    ├── piv-engine/    Plan → Implement → Validate state machine
    ├── agent/         Child agent registry, spawner, and color assignment for coordinator mode
    ├── coordinator/   Worker manifest planning, dependency ordering, and parallel execution engine
    ├── compaction/    Conversation compaction (snip and full strategies)
    ├── snapshots/     Per-turn file snapshot diffing and restore
    ├── approval/      Plan approval modes: CLI, webhook, Slack, and auto
    ├── permissions/   Tool permission policy and approval-request types
    ├── context-window/ Token budget accounting and ContextBudgetGuard
    ├── file-tools/    Built-in repository read/write/search tools
    ├── web-tools/     Opt-in search and fetch tools with SSRF protection
    ├── memory/        Durable project memory materialized into MEMORY.md
    ├── hooks/         Event hooks with timeout-bounded execution
    ├── skills/        Built-in and custom slash-command skills
    ├── protocol/      CLI ↔ daemon message types
    └── ui-core/       Headless state hooks shared by CLI and VS Code webview
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
- [x] Multi-repo context spanning more than one repository
- [x] VS Code extension — visual diff approval and side-by-side plan review
- [x] Cloud sandbox tier — hosted execution, zero local Docker setup
- [x] Memory system — `/remember`, `/memory`, `MEMORY.md`, and automatic memory
- [x] File tools — built-in read, write, edit, glob, and grep
- [x] Web tools — opt-in search and fetch with SSRF protection
- [x] Diagnostics and context tools — `iq doctor`, `/doctor`, `/context`, `/diff`, `/export`
- [x] Code review — `iq review` and `/review`
- [x] Effort levels — `/fast`, `/normal`, `/thorough`, and `iq task --effort`
- [x] Hooks — shell and JS hooks with event subscriptions
- [x] Skills — built-in and hot-reloaded custom slash commands
- [x] Keybindings — user-configurable REPL chords
- [x] Worktree mode — `iq task --worktree` session branches
- [x] Conversation compaction — `/compact` and automatic threshold-based compaction
- [x] File snapshots — per-turn snapshots with `/snapshots` restore
- [x] Context budget guard — automatic compaction before the context window fills
- [x] Agent orchestration — `iq task --coordinator` spawns parallel agents on worktree branches, merges validated results

---

## License

[Apache 2.0](LICENSE) © [Ayham Joumran](https://github.com/AyhamJo7)
