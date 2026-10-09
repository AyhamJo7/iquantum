# Configuration reference

[← Back to iquantum](README.md)

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
