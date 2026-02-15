# Development Guide

## Project Structure

```
imessage-claude-code/
├── bin/
│   ├── imessage-claude.ts    # NPM bin entry point (shebang wrapper → src/cli.ts)
│   └── clawty.ts             # Alternative bin entry point (identical)
├── src/
│   ├── cli.ts                # Full bridge — args, banner, polling loop, slash commands,
│   │                         #   streaming Claude subprocess, erase-and-redraw TUI
│   ├── index.ts              # Public library exports
│   ├── imessage/
│   │   ├── types.ts          # TypeScript interfaces (IMessage)
│   │   ├── database.ts       # SQLite reader for ~/Library/Messages/chat.db
│   │   └── sender.ts         # JXA/AppleScript iMessage sender via temp files
│   └── claude/
│       └── runner.ts         # Claude Code CLI preflight check (verifyClaudeInstalled)
├── package.json
├── tsconfig.json
└── bun.lock
```

Zero runtime dependencies — uses only Bun built-ins.

## Running in Development

```bash
bun install
bun run src/cli.ts -c "+1234567890"
bun run src/cli.ts -c "+1234567890" -d ~/projects/myapp -m sonnet
```

## Build & Verify

```bash
bun install
bunx tsc --noEmit                                           # Type check
bun build src/cli.ts --target=bun > /dev/null && echo "OK"  # Bundle check
```

## Architecture

### Overview

`cli.ts` is the entire bridge in a single file. On startup it:

1. Parses CLI args (or prompts interactively for `--contact`)
2. Runs preflight checks — Claude CLI installed, Messages.app reachable, Full Disk Access
3. Opens `chat.db` read-only via `IMessageDatabase`, resolves the contact handle
4. Sends a startup iMessage to the contact
5. Enters a polling loop checking two sources every `--interval` ms:
   - `chat.db` for new incoming iMessages
   - `stdin` for messages typed locally in the terminal
6. Processes slash commands locally
7. Spawns `claude -p` as a subprocess with `--output-format stream-json` for normal messages
8. Parses streaming NDJSON to display thinking, tool calls, and text in real time
9. Sends the final result text back via iMessage

### Claude Subprocess

Each message spawns a `claude` process:

```
claude -p "<message>" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --dangerously-skip-permissions \
  --session-id <uuid>          # first message
  # OR
  -r <uuid>                    # subsequent messages
```

- First message includes `--append-system-prompt` telling Claude it's being contacted via iMessage
- `--model` is passed through if set via CLI or `/model`
- `--permission-mode` overrides `--dangerously-skip-permissions` if set to anything other than `bypassPermissions`
- `CLAUDECODE=""` is set in the subprocess environment to avoid nested session guard issues

### Session Management

- **Session ID**: `crypto.randomUUID()` generated at startup
- **First message**: `--session-id <uuid>` creates a new session
- **Subsequent messages**: `-r <uuid>` resumes the existing session
- **`/new`**: Generates a fresh UUID, resets all counters
- **`/compact`**: Asks Claude to summarize the conversation, then starts a fresh session with the summary baked into the system prompt via `--append-system-prompt`
- **`/resume <id>`**: Resumes an arbitrary session by UUID

### Streaming NDJSON Events

The bridge parses these event types from `claude -p --output-format stream-json`:

| Type | Subtype | Display |
|------|---------|---------|
| `system` | init | Session ID, model, version, MCP servers, tool counts |
| `stream_event` | thinking_delta | Thinking spinner with dot progress and preview |
| `stream_event` | text_delta | Streamed text as it arrives |
| `assistant` | tool_use | Tool name + first meaningful input param |
| `user` | tool_result | Output preview (first 5 lines), errors in red |
| `result` | — | Turn count, duration, cost summary |

### Message Queue

The bridge uses a unified message queue for both iMessage and terminal input:
- iMessages are polled from `chat.db` and added to the queue
- Terminal input is added when the user presses Enter
- All pending messages in a batch are concatenated into a single prompt
- New messages arriving during processing are queued and shown with `○ queued (N pending)`
- After processing completes, queued messages are drained immediately

## Terminal UI (Erase-and-Redraw)

The TUI uses an **erase-and-redraw** pattern (like Ink) rather than scroll regions or cursor save/restore, which are unreliable across terminal emulators (iTerm2, Terminal, Warp).

### Two Zones

- **Permanent output** — banner, messages, tool output. Scrolls up naturally, never erased.
- **Dynamic section** — prompt and/or spinner at the bottom. Erased and redrawn on every update.

### Three UI States

| State | Dynamic Lines | Content |
|-------|---------------|---------|
| Idle | 1 | `> input` (prompt only) |
| Thinking | 2 | `⠋ Thinking...` + `> input` (spinner + prompt) |
| Streaming | 1 | `> input` below streaming text (prompt pinned) |

### Key State Variables

- `dynamicLineCount` — number of ephemeral bottom lines to erase before each update
- `streamingActive` — whether Claude is currently streaming text output
- `streamingCol` — cursor column within streaming text (for position restoration after prompt erase)
- `spinnerFrame` — shared animation frame counter (keystrokes don't affect speed)
- `inputBuffer` — accumulates typed characters; submitted on Enter
- `promptVisible` — whether the prompt is currently drawn

### Key Functions

- `eraseLines(n)` — clears N lines using `\x1b[2K` (clear line) + `\x1b[1A` (cursor up) + `\r` (carriage return)
- `redrawPrompt()` — erases dynamic section, redraws prompt; delegates to `drawSpinnerAndPrompt()` during thinking
- `writePermanent(text)` — erases dynamic section, writes permanent text, redraws dynamic section
- `writeStreaming(text)` — erases prompt, moves cursor up to streaming line, restores column, writes text, redraws prompt below
- `drawSpinnerAndPrompt()` — draws 2-line spinner + prompt using shared `spinnerFrame`
- `updateStreamingCol(text)` — tracks cursor column through streaming text, skipping ANSI escape sequences
- `startSpinner()` / `clearSpinner()` — 80ms interval animation with 10 braille dot frames

### Input Handling

Raw mode (`process.stdin.setRawMode(true)`) captures every keystroke via `handleChar()`:
- Characters accumulate in `inputBuffer`, prompt redraws on each keystroke
- Enter submits the message
- Backslash+Enter enables multi-line continuation (shows `..` prefix)
- Ctrl+C / Ctrl+D triggers graceful shutdown
- Escape sequences (arrow keys) are swallowed
- All `console.log`/`console.error` are overridden to route through `writePermanent()`

## iMessage Database

- **Location**: `~/Library/Messages/chat.db`
- **Access**: Read-only via `bun:sqlite` with `PRAGMA busy_timeout = 3000` (waits up to 3s if Messages.app locks during WAL checkpoint)
- **Timestamps**: Nanoseconds or seconds since Apple epoch (2001-01-01 00:00:00 UTC) — both formats handled
- **Text extraction**: `text` column may be NULL on newer macOS; falls back to `attributedBody` (NSAttributedString binary blob) with three strategies: NSString marker, bplist marker, and longest-printable-run brute force
- **Filtering**: `cache_roomnames IS NULL` excludes group chats; `is_from_me = 0` filters to incoming only
- **Row tracking**: ROWIDs are monotonically increasing; `processedRowIds` set prevents duplicates (pruned to last 500 when >1000)
- **Contact matching**: Exact match first, then phone number variations (±1 prefix, stripped formatting)

## iMessage Sending

Two approaches, tried in order:
1. **JXA** (JavaScript for Automation): `chats.whose({id: {_contains: contact}})`, reads message from temp file via `NSString.stringWithContentsOfFileEncodingError`
2. **AppleScript** (fallback): Tries `participant` syntax first, then `buddy` syntax, reads from temp file via `read ... as «class utf8»`

Both avoid embedding message content in the script string (injection-safe). Long messages (>15000 chars) are split at natural breakpoints (`\n\n` → `\n` → space) and sent as numbered chunks (`[1/3]`, `[2/3]`, etc.) with 500ms delay between them.

## Echo Detection

Recently sent messages are tracked by fingerprint (first 150 chars, lowercased, trimmed). Incoming messages matching a fingerprint within 5 minutes are skipped. `advanceCursorWithDelay()` polls the DB multiple times over ~1.5s after sending to catch the `is_from_me=0` echo copy that iMessage creates when messaging yourself.

## Slash Commands

Commands are processed in `handleSlashCommand()` and return a `CommandResult`:

```typescript
interface CommandResult {
  handled: boolean;
  reply: string | null;
  sendToClaude: boolean;
  claudeMessage?: string;
}
```

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

Commands returning `sendToClaude: false` are handled locally. `/compact` sends a summarization prompt to Claude, extracts the summary, then starts a fresh session with the summary in the system prompt.

## Adding Features

### Adding a new slash command

In `handleSlashCommand()` in `src/cli.ts`, add a new case:

```typescript
case "/mycommand": {
  return { handled: true, reply: "Response text", sendToClaude: false };
}
```

Then add the command to `HELP_TEXT` (also in `src/cli.ts`).

### Adding a new CLI flag

1. Add to the `CliArgs` interface and `parseArgs()` switch statement in `src/cli.ts`
2. Update `printUsage()` to document it
3. Use it in the relevant part of the main loop or pass to `runClaudeStreaming()`

## Debugging

### Testing Individual Components

**Test iMessage database access:**
```bash
bun --eval "
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
const db = new Database(join(homedir(), 'Library/Messages/chat.db'), { readonly: true });
const count = db.query('SELECT COUNT(*) as c FROM message').get();
console.log('Messages in DB:', count);
const latest = db.query('SELECT m.ROWID, m.text, h.id as sender FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID ORDER BY m.ROWID DESC LIMIT 3').all();
console.log('Latest:', latest);
db.close();
"
```

**Test iMessage sending:**
```bash
bun --eval "
import { sendIMessage } from './src/imessage/sender.ts';
await sendIMessage('+1234567890', 'Test message');
console.log('Sent!');
"
```

### Common Issues

**"authorization denied" on chat.db:**
Your terminal needs Full Disk Access. After granting it in System Settings, you **must** restart the terminal completely (not just the tab).

**Messages not being detected:**
```bash
# Check what contact IDs exist in the DB
bun --eval "
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
const db = new Database(join(homedir(), 'Library/Messages/chat.db'), { readonly: true });
const handles = db.query('SELECT DISTINCT id, service FROM handle ORDER BY id').all();
console.log(JSON.stringify(handles, null, 2));
db.close();
"
```
The contact format must match (e.g., `+11234567890` not `1234567890`). The bridge generates phone number variations automatically, but the base number needs enough digits to match.

**AppleScript/JXA failures:**
```bash
# JXA test
osascript -l JavaScript -e '
var app = Application("Messages");
var accounts = app.accounts();
for (var i = 0; i < accounts.length; i++) {
  console.log(accounts[i].serviceType() + ": " + accounts[i].id());
}
'

# AppleScript test
osascript -e 'tell application "Messages" to get name'
```

**Claude CLI not responding:**
```bash
claude -p "Say hello" --output-format text
echo $?  # Should be 0
claude --version
```
