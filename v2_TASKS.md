Based on the v2 architecture /home/adam/projects/active/iquantum/v2_ARCHITECTURE.md just designed, here is the
  full build plan. v1 is the foundation — nothing here
  replaces it; every phase adds to it.

  ---
  iquantum v2 — Implementation Task Breakdown

  ---
  Phase 0: Schema & Protocol Foundation

  Goal: new DB tables migrated, extended SSE frame types
  published, CI green on new packages

  - S Migration 2 — messages table: add to migration runner
  in iquantum-daemon/src/db/schema.ts — id, session_id,
  role, content (JSON), has_thinking, token_count,
  compaction_boundary, created_at
  - S Migration 3 — tool_uses table: id, message_id,
  tool_name, input, output, approved, created_at
  - S Create packages/protocol/: extract existing
  ServerStreamFrame from iquantum-cli/src/client.ts + add
  new frame types: thinking, diff_preview,
  permission_request, compact_boundary, mcp_tool_call, done
  — export as @iquantum/protocol
  - S Create packages/context-window/: token-counting
  helpers using @anthropic-ai/tokenizer; exports
  countTokens(messages), needsCompaction(count,
  modelContextWindow) (threshold: 87%)
  - S Wire new packages into workspace — add to root
  package.json workspaces, update tsconfig.json references,
  update CI

  ▎ ✓ Phase 0 done when: bun run build + bun run test green,
  ▎  migration runner applies migrations 2 and 3 on fresh DB

  ---
  Phase 1: Multi-Turn Conversation Backend

  Goal: daemon accepts multi-turn messages, stores history,
  streams responses — testable with curl

  - M ConversationController
  (iquantum-daemon/src/conversation-controller.ts):
  addMessage(), getMessages(), getMessagesForApi() (excludes
   pre-compaction-boundary messages), getTokenCount() —
  backed by the new messages table
  - S POST /sessions/:id/messages in server.ts: body { role:
   "user", content: string } → calls
  ConversationController.addMessage() → triggers LLM call →
  streams response via existing SSE; returns 202
  - S GET /sessions/:id/messages in server.ts:
  cursor-paginated (?before=<id>&limit=50), returns {
  messages, nextCursor }
  - S DELETE /sessions/:id/messages in server.ts: clears
  history (no compaction summary — just wipe)
  - M CompactionService
  (iquantum-daemon/src/compaction-service.ts):
  maybeCompact(sessionId) — if needsCompaction(), calls
  architect model with summarization prompt, writes a
  compaction_boundary=true message, emits compact_boundary
  SSE frame
  - S POST /sessions/:id/compact in server.ts: explicit
  trigger for CompactionService.compact()
  - S Emit done frame from StreamController when session
  finishes cleanly (so CLI knows stream is over, not
  dropped)
  - M Tests: ConversationController unit tests, compaction
  threshold tests, /messages endpoint integration tests
  (happy path + pagination + 404)

  ▎ ✓ Phase 1 done when: curl -X POST
  ▎ .../sessions/:id/messages -d
  ▎ '{"role":"user","content":"hello"}' streams tokens back,
  ▎  history is stored, a second message continues the
  ▎ conversation

  ---
  Phase 2: Permission Gate & Diff Preview

  Goal: daemon can pause mid-task for user approval; diffs
  stream before they're applied

  - M PermissionGate
  (iquantum-daemon/src/permission-gate.ts):
  requestPermission(sessionId, requestId, tool, input) —
  emits permission_request SSE frame, returns a
  Promise<boolean> that suspends until resolvePermission()
  is called
  - S POST /sessions/:id/permission in server.ts: body {
  requestId: string, approved: boolean } → calls
  PermissionGate.resolvePermission() → returns { ok: true }
  - M ⚠️  Wire PermissionGate into PIVEngine: before any file
   write in the Implement phase, emit a diff_preview SSE
  frame (file + patch) and gate on user approval if
  requireApproval: true is set in session config
  - S permission_request → auto-approve mode: session config
   flag autoApprove: boolean; when true, PermissionGate
  resolves immediately without waiting (for headless iq task
   compat)
  - M Tests: PermissionGate unit test (approve path, reject
  path, timeout), /permission endpoint test

  ▎ ✓ Phase 2 done when: curl .../stream emits
  ▎ permission_request, then curl .../permission -d
  ▎ '{"requestId":"x","approved":true}' unblocks the
  ▎ implement phase

  ---
  Phase 3: Ink REPL Foundation

  Goal: iq opens a terminal UI — splash screen, empty input
  box, status bar — daemon auto-starts if not running

  - S Add Ink dependencies to iquantum-cli/package.json:
  ink, react, @types/react, @types/ink (or @ink/types)
  - M Splash component
  (iquantum-cli/src/components/Splash.tsx): renders iquantum
   ASCII art block characters, reveals left-to-right at
  8ms/char via setInterval inside useEffect, then fades in
  version + model + session ID line — total ≤600ms; skip on
  session resume
  - M IQApp (iquantum-cli/src/app.tsx): Ink root; renders
  <Splash> then transitions to <REPL> on completion
  - S StatusBar (iquantum-cli/src/components/StatusBar.tsx):
   bottom-fixed <Box> with model name, session ID (first 8
  chars), token count (from compact_boundary frames), mode
  indicator
  - S PromptInput skeleton
  (iquantum-cli/src/components/PromptInput.tsx): single-line
   input using Ink's useInput; enter to submit; up/down for
  history; placeholder >  when empty
  - M REPL skeleton (iquantum-cli/src/screens/REPL.tsx):
  wraps MessageList (empty) + SpinnerWithPhase (hidden when
  idle) + PromptInput + StatusBar; submission calls
  DaemonClient.postMessage() and attaches SSE stream
  - S Update iq CLI entry: iq with no args now calls
  renderAndRun(<IQApp>); iq task "..." still calls old
  startTask() path (backward compat, auto-approve mode)
  - M Auto-start daemon: if DaemonClient.health() fails with
   ENOENT/ECONNREFUSED, IQApp spawns iq daemon start as a
  child process, waits for socket to appear (poll health()
  every 200ms, timeout 10s), then renders <Splash>

  ▎ ✓ Phase 3 done when: iq shows the animated splash + > 
  ▎ prompt; typing a message and pressing enter doesn't
  ▎ crash (response not yet displayed, just sent)

  ---
  Phase 4: Chat Rendering — Streaming + Thinking + Spinner

  Goal: full token-by-token streaming in the chat,
  phase-aware spinner, thinking blocks collapsed by default

  - M MessageList
  (iquantum-cli/src/components/MessageList.tsx): renders
  past messages + the live streaming message; UserMessage
  (dim, right-aligned prefix you) and AssistantMessage
  (Markdown-rendered via marked + ANSI) components
  - S SpinnerWithPhase
  (iquantum-cli/src/components/Spinner.tsx): animates at
  50ms via useEffect + useState; verb per phase: Connecting
  / Thinking / Planning / Implementing / Validating; shows
  elapsed seconds; hides when idle
  - M SSE integration in REPL: consume stream inside
  useEffect, dispatch frame types to React state — token →
  append to streamingText, phase_change → update spinner
  phase, thinking → append to thinkingText, done → finalize
  message, error → show error message
  - S ThinkingBlock
  (iquantum-cli/src/components/ThinkingBlock.tsx): renders ∴
   Thinking [ctrl+o to expand] by default; full thinking
  text shown when expanded=true; ctrl+o toggles expanded in
  REPL state
  - S compact_boundary separator: when stream emits
  compact_boundary, render a dim ─── context compacted ───
  rule in the transcript
  - M Virtual scroll
  (iquantum-cli/src/components/VirtualMessageList.tsx): wrap
   MessageList in a ScrollBox (Ink's scrollable container or
   manual ANSI scroll); freeze off-screen messages with
  React.memo + stable keys to prevent re-render; scroll to
  bottom on new message

  ▎ ✓ Phase 4 done when: iq → type a message → spinner shows
  ▎  Thinking… → tokens stream inline character by character
  ▎  → message finalizes in transcript

  ---
  Phase 5: Inline Diffs & Permission UI

  Goal: diffs render syntax-highlighted in the chat before
  they're applied; approval prompts appear inline

  - M StructuredDiff
  (iquantum-cli/src/components/StructuredDiff.tsx): receives
   { file, patch } from diff_preview frame; parses with diff
   npm package; renders gutter (line numbers + +/- markers)
  + syntax-highlighted content lines using chalk; dim color
  for context, green for additions, red for deletions
  - S diff_preview frame handling in REPL: on diff_preview
  frame, add a DiffMessage entry to transcript; render with
  <StructuredDiff>
  - M PermissionRequest
  (iquantum-cli/src/components/PermissionRequest.tsx): on
  permission_request frame, render inline dialog: tool name,
   input summary, [y] approve  [n] reject  [a] approve all;
  on keypress, call DaemonClient.postPermission(requestId,
  approved) and remove dialog
  - S permission_request pauses input: while a
  PermissionRequest is rendered, PromptInput is disabled
  (Ink isFocused=false); re-enables after resolution
  - S checkpoint frame: on checkpoint frame, render dim ✓
  checkpoint abc1234 line in transcript

  ▎ ✓ Phase 5 done when: iq → run a task → diff appears
  ▎ inline before apply → y to approve → diff is applied →
  ▎ checkpoint appears

  ---
  Phase 6: Slash Command System & Keyboard Shortcuts

  Goal: full /command system, tab-complete, all documented
  shortcuts working

  - M CommandRegistry (iquantum-cli/src/commands/index.ts):
  registry of LocalCommand objects { name, description,
  run(args, context) } + lazy-load pattern;
  getCompletions(prefix) for tab-complete
  - S Tab-complete in PromptInput: when input starts with /,
   show inline completion list below input using
  CommandRegistry.getCompletions(); tab to accept
  - S Implement all slash commands:
    - /approve → DaemonClient.approve(sessionId)
    - /reject <feedback> → DaemonClient.reject(sessionId,
  feedback)
    - /plan → DaemonClient.currentPlan(sessionId) → render
  in transcript
    - /clear → DaemonClient.deleteMessages(sessionId) +
  clear local transcript
    - /compact → DaemonClient.compact(sessionId)
    - /model → show current models, allow switching via env
  var hint
    - /status → render session ID, container status, token
  count
    - /restore → render list of checkpoints (arrow-key
  picker), call DaemonClient.restore()
    - /help → render command table
    - /quit → process.exit(0) (sandbox persists)
  - S Keyboard shortcuts:
    - escape → cancel in-flight stream (call
  DaemonClient.destroySession is wrong — need a POST
  /sessions/:id/cancel endpoint or just close SSE)
    - ctrl+l → redraw (clear terminal, re-render REPL)
    - ctrl+o → toggle ThinkingBlock expanded
    - up/down in empty input → navigate prompt history
    - ctrl+c (double-press, 500ms window) → exit
  - S POST /sessions/:id/cancel in daemon: aborts the
  in-flight LLM stream without destroying the session or
  container

  ▎ ✓ Phase 6 done when: /approve approves a plan, /restore 
  ▎ shows checkpoint picker, escape aborts a running stream
  ▎ without killing the container

  ---
  Phase 7: MCP Activation

  Goal: daemon actually connects to MCP servers; tools
  appear in the conversation as first-class calls

  - M ⚠️  McpClient (iquantum-daemon/src/mcp-client.ts):
  spawns MCP server process via stdio using
  @modelcontextprotocol/sdk; listTools(), callTool(name,
  input) — one process per configured MCP server
  - S MCP config in .env.example: document
  IQUANTUM_MCP_SERVERS as JSON array [{"name":"...",
  "command":"...","args":[...]}]
  - M Wire MCP tools into ConversationController: merge
  McpClient.listTools() into the tool list sent with each
  LLM call; on tool_use block, dispatch to
  McpClient.callTool() if it matches an MCP tool; emit
  mcp_tool_call SSE frame; run through PermissionGate
  - S /mcp slash command: list configured servers +
  connection status; bun run iq mcp add <name> <command> to
  add (writes to .iquantum/mcp.json)
  - M Tests: McpClient unit test with a mock stdio MCP
  server; tool dispatch integration test

  ▎ ✓ Phase 7 done when: configure the @context7 MCP server,
  ▎  run iq, ask a question requiring docs → mcp_tool_call 
  ▎ frame appears in chat, answer includes fetched
  ▎ documentation

  ---
  Phase 8: Session Resume & Polish

  Goal: iq reopens the previous conversation; performance
  holds on 200+ message transcripts

  - S Session persistence across CLI restarts: on IQApp
  init, check ~/.iquantum/last-session file; if it exists
  and session is still live (daemon is running, container
  up), skip session creation and load message history via
  GET /sessions/:id/messages
  - S Write ~/.iquantum/last-session on every
  createSession() call in CLI
  - S Transcript load on resume: fetch last 50 messages,
  render in MessageList before accepting input; dim
  separator ─── resumed ───
  - M Performance audit: open a session with 200+ messages,
  measure render time; add React.memo to MessageList items
  if re-render on keystroke exceeds 16ms; add
  OffscreenFreeze wrapper to messages scrolled >2 screens
  above viewport
  - S Markdown render cache: WeakMap-based cache keyed on
  (content, terminalWidth) — skip marked re-parse for
  messages already in transcript
  - S Daemon crash recovery: if daemon socket disappears
  mid-session (daemon crashed), REPL detects ECONNREFUSED on
   next request, shows daemon disconnected — restart with iq
   daemon start, prompts to reconnect

  ▎ ✓ Phase 8 done when: iq → chat → ctrl+c → iq again →
  ▎ previous conversation reappears, new input continues the
  ▎  thread

  ---
  Deferred (post-v2)

  - Vim mode in PromptInput — full motions/operators;
  feature-flagged IQUANTUM_VIM_MODE=1
  - VS Code / JetBrains extension — IDE diff display +
  approval UI alongside the CLI
  - Multi-repo context — repo map spanning multiple repos
  via IQUANTUM_EXTRA_REPOS config
  - Browser automation — Playwright inside the sandbox
  container (Validate phase visual diff)
  - Cloud sandboxes + auth — multi-user, RBAC, hosted
  containers (paid tier)
  - OpenAI-compatible provider wired into daemon — currently
   exists in packages/llm but not activated
  - Fleet automation mode — batch tasks across repos via SDK
   (OpenHands use case)
  - /voice input — Whisper transcription piped into
  PromptInput
  - Canary metrics — optional Sentry + structured usage
  metrics (opt-in)

  ---
  Risks & Unknowns

  Task: Phase 3 — Ink integration
  Risk: ⚠️  Ink and Bun have historically had issues with raw

    mode + stdin in non-TTY environments
  Mitigation: Test early on WSL2 and in a Docker TTY; have a

    fallback readline path for non-interactive use
  ────────────────────────────────────────
  Task: Phase 4 — Virtual scroll
  Risk: ⚠️  Ink's ScrollBox is not widely documented; may
  need
    to roll a manual ANSI scroll implementation
  Mitigation: Prototype with 50-message transcript in week 1

    of Phase 4 before committing to the approach
  ────────────────────────────────────────
  Task: Phase 7 — MCP stdio
  Risk: ⚠️  @modelcontextprotocol/sdk has not been tested in
    Bun with Vitest vmForks pool
  Mitigation: Add an MCP smoke test early; known Bun ESM
    resolution issues with this pool — may need inline pool
    for MCP tests
  ────────────────────────────────────────
  Task: Phase 2 — Permission suspension
  Risk: ⚠️  Daemon awaiting a HTTP POST inside an SSE handler

    means the stream socket must stay open; Bun SSE idle
    timeout is the exact bug we just fixed
  Mitigation: Verify keepalive heartbeat covers the full
    permission-wait window (can be 60+ seconds for slow
    approvals)

  ---