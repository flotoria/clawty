# Agent Instructions

## Overview

`clawty` is an iMessage-to-Claude Code bridge built with Bun. It polls `chat.db` for incoming iMessages, runs `claude -p` as a streaming subprocess, and sends the response back via iMessage. The terminal shows a live TUI with an always-visible input prompt, animated thinking spinner, streaming output with cursor tracking, and message queuing.

## Project Stack

- **Runtime**: Bun (not Node.js) — zero runtime dependencies
- **Language**: TypeScript (strict mode, ESNext target)
- **SQLite**: `bun:sqlite` (built-in, not `better-sqlite3`)
- **Claude integration**: `claude -p` subprocess with `--output-format stream-json`
- **iMessage**: JXA primary, AppleScript fallback — both use temp files (no string injection)

## File Map

| File | Purpose |
|------|---------|
| `src/cli.ts` | Full bridge — arg parsing, preflight checks, banner, polling loop, slash commands, streaming Claude subprocess, erase-and-redraw TUI, raw stdin input, iMessage send |
| `src/index.ts` | Public library exports (`IMessageDatabase`, `sendIMessage`, `verifySendPermission`, `verifyClaudeInstalled`, `IMessage` type) |
| `src/imessage/types.ts` | `IMessage` interface (rowId, text, sender, date, isFromMe, service, chatId) |
| `src/imessage/database.ts` | SQLite reader for `~/Library/Messages/chat.db` — polls by ROWID, extracts text from `attributedBody` blobs, phone number variation matching |
| `src/imessage/sender.ts` | JXA + AppleScript iMessage sender (temp-file based). Splits long messages (>15000 chars) into numbered chunks |
| `src/claude/runner.ts` | Preflight check — `verifyClaudeInstalled()` |
| `bin/clawty.ts` | Bin entry point (shebang wrapper → `src/cli.ts`) |
| `bin/clawty.ts` | Alternative bin entry point (identical) |

## Conventions

- Use `bun:sqlite` for all SQLite operations (read-only access to chat.db)
- Never embed user-controlled content in AppleScript/JXA strings — always use temp files
- Use parameterized SQL queries (`?1`, `?2`) — never string interpolation
- Slash commands go in `handleSlashCommand()` and return a `CommandResult`
- The TUI uses erase-and-redraw (not scroll regions or cursor save/restore)
- `console.log`/`console.error` are overridden to route through `writePermanent()`
- All async error paths must be caught — no unhandled rejections

## Architecture

### Bridge Flow

`cli.ts` is the entire bridge in a single file. On startup:
1. Parse args (or prompt interactively for `--contact`)
2. Preflight checks (Claude CLI, Messages.app, Full Disk Access)
3. Open `chat.db` read-only, resolve contact handle
4. Send startup iMessage, show banner, enter polling loop

For each message batch:
1. Slash commands handled locally
2. Normal messages spawn `claude -p "<message>" --output-format stream-json --verbose --dangerously-skip-permissions` with `--session-id <uuid>` (first) or `-r <uuid>` (subsequent)
3. Streaming NDJSON parsed line-by-line: thinking, tool calls, text displayed in real time
4. Final result text sent back via iMessage
5. `CLAUDECODE=""` in subprocess env to avoid nested session guard

### Session Management

- `crypto.randomUUID()` at startup
- First message: `--session-id <uuid>` + `--append-system-prompt` (iMessage context)
- Subsequent: `-r <uuid>` to resume
- `/new` resets UUID and state; `/compact` summarizes then starts fresh; `/resume <id>` resumes arbitrary session

### Slash Commands

| Command | Aliases | Sends to Claude |
|---------|---------|-----------------|
| `/help` | `/commands` | No |
| `/new` | `/reset` | No |
| `/compact` | — | Yes (summarization prompt) |
| `/status` | — | No |
| `/model <name>` | — | No |
| `/dir <path>` | `/cd` | No |
| `/cost` | — | No |
| `/resume <id>` | — | No |
| `/whoami` | — | No |

### Streaming NDJSON Events

| Type | Subtype | Content |
|------|---------|---------|
| `system` | init | session_id, model, tools, mcp_servers, version |
| `stream_event` | thinking_delta | Thinking progress |
| `stream_event` | text_delta | Streamed response text |
| `assistant` | tool_use | Tool name + input params |
| `user` | tool_result | stdout/stderr, is_error |
| `result` | — | result text, total_cost_usd, num_turns, duration_ms |

### Terminal UI (Erase-and-Redraw)

Two zones: **permanent** (scrolls up) and **dynamic** (erased/redrawn at bottom).

Three states:
- **Idle**: 1 dynamic line (`> input`)
- **Thinking**: 2 dynamic lines (spinner + prompt)
- **Streaming**: 1 dynamic line (prompt pinned below streaming text)

Key state: `dynamicLineCount`, `streamingActive`, `streamingCol`, `spinnerFrame`, `inputBuffer`, `promptVisible`.

Key functions: `eraseLines()`, `redrawPrompt()`, `writePermanent()`, `writeStreaming()`, `drawSpinnerAndPrompt()`, `updateStreamingCol()`.

### Input Handling

Raw mode stdin captures every keystroke. Enter submits, backslash+Enter for multi-line, Ctrl+C/D for shutdown. All `console.log`/`console.error` routed through `writePermanent()`.

### Echo Detection

Recently sent messages tracked by fingerprint (first 150 chars, lowercased). Matches within 5 minutes are skipped. `advanceCursorWithDelay()` polls ~1.5s after sending to catch `is_from_me=0` echo copies. `processedRowIds` prevents duplicate ROWID processing.

### iMessage Database Details

- Read-only via `bun:sqlite`, `PRAGMA busy_timeout = 3000`
- Text from `text` column or `attributedBody` fallback (3 extraction strategies)
- `cache_roomnames IS NULL` excludes groups; `is_from_me = 0` filters incoming
- Contact matching: exact first, then phone variations (±1 prefix)
- `processedRowIds` pruned to 500 when >1000

## Build & Verify

```bash
bun install
bunx tsc --noEmit                                           # Type check
bun build src/cli.ts --target=bun > /dev/null && echo "OK"  # Bundle check
```

## Security Invariants

1. Only the configured contact triggers Claude — SQL `WHERE h.id = ?`
2. Group chats filtered — `WHERE m.cache_roomnames IS NULL`
3. Only incoming messages polled — `WHERE m.is_from_me = 0`
4. Message content never in script strings — temp files only
5. Parameterized SQL — no string interpolation
6. `--dangerously-skip-permissions` by default — warned at startup
7. Echo detection prevents infinite loops
8. Long messages chunked at natural breakpoints (>15000 chars)
9. `CLAUDECODE=""` prevents nested session guard
