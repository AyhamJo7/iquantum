# Usage guide

[← Back to iquantum](README.md) · [Configuration](CONFIGURATION.md)

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

With interactive approval enabled, the PIV workflow waits for plan approval before implementation. If you are not happy with the plan, type `no` and explain what to change — the agent will revise and show you a new plan.

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

