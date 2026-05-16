  iquantum v2 Architecture

  Vision

  v1 proved the PIV loop works. v2 wraps it in a persistent
  chat REPL — you open iq once, and you're in a conversation
   with the agent inside your Docker sandbox. Tasks are no
  longer one-shot requests; they're turns in an ongoing
  session. The daemon keeps the sandbox alive; the CLI
  becomes a first-class Ink-based TUI.

  ---
  Components

  CLI Layer — iquantum-cli/src/

  Component: IQApp
  Responsibility: Top-level Ink root; renders Splash then
    REPL
  Talks to: REPL, DaemonClient
  ────────────────────────────────────────
  Component: Splash
  Responsibility: Animated ASCII art on launch, version +
    model line
  Talks to: —
  ────────────────────────────────────────
  Component: REPL
  Responsibility: Persistent chat loop; owns all
  input/output
    state
  Talks to: DaemonClient, all child components
  ────────────────────────────────────────
  Component: MessageList
  Responsibility: Virtual-scroll transcript; freezes
    off-screen messages
  Talks to: StructuredDiff, ThinkingBlock, PermissionRequest
  ────────────────────────────────────────
  Component: PromptInput
  Responsibility: Multi-line input; history navigation;
    slash-command autocomplete; vim mode
  Talks to: CommandRegistry
  ────────────────────────────────────────
  Component: SpinnerWithPhase
  Responsibility: Phase-aware animation: requesting →
    thinking → planning → implementing → validating
  Talks to: —
  ────────────────────────────────────────
  Component: StructuredDiff
  Responsibility: Syntax-highlighted inline diffs with
  gutter
    line numbers
  Talks to: —
  ────────────────────────────────────────
  Component: ThinkingBlock
  Responsibility: Collapsed ∴ Thinking [ctrl+o] by default;
    expands on toggle
  Talks to: —
  ────────────────────────────────────────
  Component: PermissionRequest
  Responsibility: Inline per-tool approval dialog; pauses
    stream until user responds
  Talks to: DaemonClient
  ────────────────────────────────────────
  Component: StatusBar
  Responsibility: Bottom bar: model name, session ID, token
    count, mode indicator
  Talks to: —
  ────────────────────────────────────────
  Component: CommandRegistry
  Responsibility: Slash-command registration, dispatch, and
    tab-complete data
  Talks to: —

  Daemon Layer — iquantum-daemon/src/

  Component: ConversationController
  Responsibility: Owns multi-turn message history; manages
    context token budget
  Talks to: CompactionService, PIVEngine, LLMClient
  ────────────────────────────────────────
  Component: CompactionService
  Responsibility: Auto-compacts when token count hits 87% of

    model context window
  Talks to: LLMClient, MessageStore
  ────────────────────────────────────────
  Component: PermissionGate
  Responsibility: Emits permission_request SSE frames;
    suspends execution until CLI responds
  Talks to: StreamController, SessionController
  ────────────────────────────────────────
  Component: McpClient
  Responsibility: Connects to configured MCP servers via
    stdio; exposes tools to ConversationController
  Talks to: External MCP processes
  ────────────────────────────────────────
  Component: PIVEngine
  Responsibility: Unchanged — Plan/Implement/Validate loop
  Talks to: SandboxManager, RepoMap, LLMClient
  ────────────────────────────────────────
  Component: StreamController
  Responsibility: Fans all frame types out to attached SSE
    sockets
  Talks to: ConversationController, PIVEngine,
  PermissionGate

  Shared — packages/

  ┌──────────────────────────┬───────────────────────────┐
  │         Package          │      Responsibility       │
  ├──────────────────────────┼───────────────────────────┤
  │ @iquantum/protocol       │ Extended SSE frame type   │
  │                          │ union (see API surface)   │
  ├──────────────────────────┼───────────────────────────┤
  │                          │ Token counting,           │
  │ @iquantum/context-window │ compaction threshold      │
  │                          │ math, message-budget      │
  │                          │ helpers                   │
  ├──────────────────────────┼───────────────────────────┤
  │                          │ StructuredDiff, Markdown, │
  │ @iquantum/ink-components │  Spinner, VirtualList —   │
  │                          │ reusable across CLI       │
  └──────────────────────────┴───────────────────────────┘

  ---
  Data Model

  New: messages

  messages
    id          TEXT PK (UUID)
    session_id  TEXT FK → sessions.id
    role        TEXT   -- 'user' | 'assistant' |
  'tool_result'
    content     TEXT   -- JSON (Anthropic ContentBlock[])
    has_thinking BOOLEAN
    token_count  INTEGER
    compaction_boundary BOOLEAN  -- true if this is a
  compaction summary
    created_at  TEXT

  New: tool_uses

  tool_uses
    id          TEXT PK (UUID)
    message_id  TEXT FK → messages.id
    tool_name   TEXT
    input       TEXT  -- JSON
    output      TEXT  -- JSON, nullable until resolved
    approved    BOOLEAN  -- null = pending, true = approved,
   false = rejected
    created_at  TEXT

  Existing (unchanged): sessions, plans, git_checkpoints

  Multi-tenancy note: all tables already have session_id as
  the first filter. No org-level isolation needed in v1/v2
  (BYOK single-user). Cloud tier (post-v2) will add user_id
  + org_id to all tables.

  ---
  API Surface

  New HTTP Endpoints

  POST   /sessions/:id/messages          -- multi-turn
  message (replaces /task for chat)
  POST   /sessions/:id/permission        -- respond to a
  permission_request frame
  GET    /sessions/:id/messages          -- conversation
  history (cursor-paginated)
  POST   /sessions/:id/compact           -- explicit
  compaction trigger
  DELETE /sessions/:id/messages          -- clear
  conversation

  Extended SSE Protocol — @iquantum/protocol

  type ServerStreamFrame =
    // existing
    | { type: "token";          delta: string }
    | { type: "phase_change";   phase: Phase }     //
  requesting|thinking|planning|implementing|validating
    | { type: "plan_ready";     planId: string }
    | { type: "validate_result"; passed: boolean; attempt:
  number }
    | { type: "checkpoint";     hash: string }
    | { type: "error";          message: string }
    // new in v2
    | { type: "thinking";       delta: string }
         // extended thinking tokens
    | { type: "diff_preview";   file: string; patch: string
  }      // inline diff before apply
    | { type: "permission_request"; requestId: string; tool:
   string; input: unknown }
    | { type: "compact_boundary"; summary: string }
         // compaction occurred here
    | { type: "mcp_tool_call";  server: string; tool: string
   }     // MCP tool in progress
    | { type: "done" }
         // stream cleanly finished

  CLI Commands

  iq                         open the REPL (default, no
  daemon required — auto-starts)
  iq task "..."              one-shot task (headless, no
  REPL; backward-compat)
  iq daemon start|stop|status
  iq restore <hash>          restore a git checkpoint
  outside of REPL

  Slash commands in REPL:

  /task <prompt>     start a PIV task explicitly
  /approve           approve the current plan
  /reject <feedback> reject with feedback
  /plan              show current PLAN.md
  /restore           interactive checkpoint picker
  (fzf-style)
  /clear             clear transcript (keeps sandbox alive)
  /compact           manual compaction
  /model             switch architect or editor model
  /status            session ID, container status, token
  usage
  /mcp               list/connect MCP servers
  /help              command list
  /quit              exit (sandbox persists)

  ---
  Infrastructure

  Need: Database
  Choice: SQLite (existing)
  Why: No change; new messages + tool_uses tables via
    migration runner
  ────────────────────────────────────────
  Need: Sandbox
  Choice: Docker named volumes (existing)
  Why: Stateful across restarts — iquantum's key advantage
    over Claude Code
  ────────────────────────────────────────
  Need: LLM
  Choice: Anthropic SDK + OpenAI-compat (existing)
  Why: Now both wired in; model per-command
  ────────────────────────────────────────
  Need: MCP servers
  Choice: stdio child processes spawned by daemon
  Why: Standard MCP spec; daemon owns lifecycle
  ────────────────────────────────────────
  Need: Terminal UI
  Choice: Ink (React for CLIs) — new in v2
  Why: Same renderer Claude Code uses; handles resize,
  focus,
    virtual scroll cleanly
  ────────────────────────────────────────
  Need: Token counting
  Choice: @anthropic-ai/tokenizer (new dep)
  Why: Needed for compaction threshold math
  ────────────────────────────────────────
  Need: Error tracking
  Choice: Sentry (optional, user opt-in via SENTRY_DSN in
    .env.example)
  Why: Invisible to users unless configured

  ---
  Architecture Diagram

    ┌───────────────────────────────────────────────────────
  ───────────┐
    │  Terminal
              │
    │
              │
    │  ┌────────────────────────────────────────────────────
  ─────────┐ │
    │  │  IQApp (Ink root)
           │ │
    │  │
           │ │
    │  │  ┌──────────────┐
  ┌──────────────────────────────────┐   │ │
    │  │  │    Splash    │ → │  REPL
      │   │ │
    │  │  │  (animated)  │   │
      │   │ │
    │  │  └──────────────┘   │
  ┌─────────────────────────────┐│   │ │
    │  │                     │  │ MessageList (virtual
  scroll) ││   │ │
    │  │                     │  │  AssistantMessage
     ││   │ │
    │  │                     │  │  StructuredDiff
     ││   │ │
    │  │                     │  │  ThinkingBlock (collapsed)
     ││   │ │
    │  │                     │  │  PermissionRequest
  (inline)  ││   │ │
    │  │                     │
  └─────────────────────────────┘│   │ │
    │  │                     │
  ┌─────────────────────────────┐│   │ │
    │  │                     │  │ SpinnerWithPhase
     ││   │ │
    │  │                     │  │
  requesting→thinking→planning ││   │ │
    │  │                     │  │ →implementing→validating
     ││   │ │
    │  │                     │
  └─────────────────────────────┘│   │ │
    │  │                     │
  ┌─────────────────────────────┐│   │ │
    │  │                     │  │ PromptInput +
  CommandRegistry││   │ │
    │  │                     │
  └─────────────────────────────┘│   │ │
    │  │                     │
  ┌─────────────────────────────┐│   │ │
    │  │                     │  │ StatusBar
  (model/tokens/mode)││   │ │
    │  │                     │
  └─────────────────────────────┘│   │ │
    │  │
  └──────────────────────────────────┘   │ │
    │  └────────────────────────────────────────────────────
  ─────────┘ │
    └───────────────────────────────────────────────────────
  ───────────┘
           │ HTTP POST /messages          ▲ SSE frames
  (token, thinking,
           │ HTTP POST /permission        │ diff_preview,
  permission_request,
           │ HTTP GET  /stream            │ phase_change,
  checkpoint, done)
           ▼                             │
    ┌───────────────────────────────────────────────────────
  ──────────┐
    │  iquantum-daemon  (~/.iquantum/daemon.sock)
             │
    │
              │
    │  ConversationController ◄──► CompactionService
             │
    │         │                           │
             │
    │         ▼                           ▼
             │
    │  PIVEngine ◄──────────────► LLMClient (Anthropic /
  OpenAI-compat)│
    │  Plan│Implement│Validate      (architect model /
  editor model)   │
    │         │
              │
    │         ▼
              │
    │  PermissionGate ──SSE──► CLI
             │
    │         │
              │
    │  SandboxManager ◄──────── McpClient (stdio child
  procs)          │
    │  (Docker named volumes)
              │
    │         │
              │
    │  SQLite (sessions, messages, tool_uses, plans,
  checkpoints)       │
    └───────────────────────────────────────────────────────
  ──────────┘
           │ docker exec (Detach:false)
           ▼
    ┌────────────────────────────┐
    │  iquantum-<session-id>     │
    │  Docker container          │
    │  iquantum-vol-<session-id> │
    │  (stateful, survives daemon│
    │   restarts — our moat vs   │
    │   Claude Code)             │
    └────────────────────────────┘

  ---
  Splash Screen

  On iq launch, a 600ms animated reveal before the REPL
  opens:


   v2.0.0
    ██╗ ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗████████╗██╗
  ██╗███╗   ███╗
    ██║██╔═══██╗██║   ██║██╔══██╗████╗  ██║╚══██╔══╝██║
  ██║████╗ ████║
    ██║██║   ██║██║   ██║███████║██╔██╗ ██║   ██║   ██║
  ██║██╔████╔██║
    ██║██║▄▄ ██║██║   ██║██╔══██║██║╚██╗██║   ██║   ██║
  ██║██║╚██╔╝██║
    ██║╚██████╔╝╚██████╔╝██║  ██║██║ ╚████║   ██║
  ╚██████╔╝██║ ╚═╝ ██║
    ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝
   ╚═╝     ╚═╝

    The AI coding agent with a stateful sandbox.
  claude-sonnet-4-5
    /help for commands · ctrl+c to exit · session: abc12345
    ────────────────────────────────────────────────────────
  ──────────────
    >

  The blocks render left-to-right character by character at
  8ms/char via setInterval, then the metadata line fades in.
   Total: ≤600ms. On subsequent opens (session resume),
  splash is skipped — goes straight to conversation history.

  ---
  Key Decisions

  Decision: Ink (React for CLIs) for the REPL
  Why this, not the alternative: Claude Code uses it and
  it's
    the only approach that handles terminal resize, focus
    routing, virtual scroll, and keyboard events cleanly at
    this complexity level. Raw ANSI strings would require
    reimplementing Yoga layout.
  ────────────────────────────────────────
  Decision: Daemon-centric conversation state
  Why this, not the alternative: The sandbox persists across

    CLI restarts (our moat). If conversation state lived in
    the CLI process, a ctrl+c would lose the thread. Daemon
    owns it, CLI is a display client.
  ────────────────────────────────────────
  Decision: permission_request as SSE frame, resolved via
    POST
  Why this, not the alternative: Keeps the SSE stream as a
    single unidirectional channel (simpler than
  bidirectional
     WebSocket). The CLI renders the approval UI, then fires

    a one-shot POST. The daemon awaits that POST inside the
    query loop — clean async suspend/resume.
  ────────────────────────────────────────
  Decision: Auto-compaction at 87% context
  Why this, not the alternative: Same threshold as Claude
    Code. Users should never see a context-full error. Fires

    invisibly; a compact_boundary frame is emitted so the
  CLI
     can render a dim separator in the transcript.
  ────────────────────────────────────────
  Decision: phase_change distinguishes 5 phases
  Why this, not the alternative: The spinner tells the user
    exactly what is happening (thinking / planning /
    implementing / validating) — not just "loading". Copied
    directly from Claude Code's 'requesting' | 'thinking' |
    'responding' | 'tool-input' | 'tool-use' pattern,
  renamed
     to match the PIV mental model.
  ────────────────────────────────────────
  Decision: MCP via daemon stdio child processes
  Why this, not the alternative: The daemon owns the sandbox

    and tool execution; MCP tools run in the same security
    context. CLI-side MCP (like Cline's approach) would let
    MCP tools escape the sandbox.
  ────────────────────────────────────────
  Decision: ThinkingBlock collapsed by default
  Why this, not the alternative: Claude Code shows ∴
  Thinking
    [ctrl+o] — a one-liner. Extended thinking tokens are
    verbose and distract from the answer. Power users expand

    on demand.
  ────────────────────────────────────────
  Decision: Virtual scroll with OffscreenFreeze
  Why this, not the alternative: Long sessions accumulate
    hundreds of messages. Re-rendering all of them on every
    keystroke is the performance failure mode Claude Code
    specifically solved. Freeze off-screen nodes, blit-cache

    rendered output.
  ────────────────────────────────────────
  Decision: iq auto-starts daemon
  Why this, not the alternative: Zero-friction first run. If

    iq detects no daemon socket, it starts the daemon
    in-process (or as a managed child), then opens the REPL.

    No iq daemon start required by default.

  ---
  What This Design Optimises For

  Developer experience depth — every interaction is in the
  terminal, every diff is inline, every approval is
  in-context, and the sandbox never dies. It sacrifices
  cloud-scalability (single-tenant SQLite + local Docker) to
   own the local developer loop completely.

  ---