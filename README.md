# Clawty

Bridge iMessage to Claude Code CLI — text Claude from your phone.

Send an iMessage from your phone and Claude Code processes it on your Mac, then texts you back the response. Maintains persistent conversation context, streams Claude's thinking and tool calls in a live terminal UI, and supports slash commands for session management.

## How It Works

| Step | What happens |
|------|-------------|
| **iPhone** | You send an iMessage |
| **Mac Messages.app** | Message lands in `chat.db` |
| **Bridge (polling)** | Reads new messages from SQLite |
| **Claude Code CLI** | `claude -p` streams thinking, tool calls, and text |
| **Bridge** | Sends the final response back via JXA/AppleScript |
| **iPhone** | You receive Claude's reply as an iMessage |

You can also type messages directly in the terminal — they're sent to Claude the same way.

## Prerequisites

- **macOS** (required — iMessage only runs on Apple platforms)
- **Bun** >= 1.0 (`curl -fsSL https://bun.sh/install | bash`)
- **Claude Code CLI** installed and authenticated:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude --version  # verify
  ```
- **Messages.app** open and signed in to iMessage

## Setup

### 1. Install

```bash
git clone https://github.com/flotoria/clawty.git
cd clawty
bun install
```

### 2. Grant macOS Permissions

**Full Disk Access** (required to read iMessage database):
1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Click **+** and add your terminal app (Terminal.app, iTerm2, Warp, etc.)
3. **Restart your terminal** after granting

**Automation** (required to send iMessages):
- macOS will prompt you on first run — click **Allow**
- Or pre-grant in **System Settings → Privacy & Security → Automation** → enable Messages for your terminal

### 3. Start the Bridge

```bash
bun run src/cli.ts --contact "+1234567890"
```

Replace `+1234567890` with your phone number (the one you'll text from). If you omit `--contact`, the bridge will prompt you for it interactively.

## Usage

### CLI Options

```
Options:
  --contact, -c <phone|email>   Contact to bridge with (prompted if omitted)
  --dir, -d <path>              Working directory for Claude Code (default: cwd)
  --model, -m <model>           Claude model (e.g. sonnet, opus, haiku)
  --interval, -i <ms>           Poll interval in ms (default: 2000)
  --permission-mode <mode>      Permission mode (default: bypassPermissions)
  --help, -h                    Show help
```

Also available as `clawty` after installing globally with `bun install -g`.

### Examples

```bash
# Basic — respond to texts from your phone number
bun run src/cli.ts -c "+1234567890"

# With a project directory so Claude has file context
bun run src/cli.ts -c "+1234567890" -d ~/projects/myapp

# Use a specific model
bun run src/cli.ts -c "+1234567890" -m opus
```

### Terminal UI

The terminal shows a live TUI with:

- **Input prompt** (`>`) — always visible at the bottom
- **Thinking spinner** — animated braille spinner while waiting for Claude
- **Streaming output** — Claude's response streams in real time, with the prompt pinned below
- **Tool calls** — shows tool name and first parameter as Claude works
- **Tool results** — previews output (first 5 lines), errors highlighted in red
- **Session info** — model, version, MCP servers, tool counts on first response
- **Cost tracking** — turn count, duration, and cost displayed after each response
- **Message queuing** — type and send messages at any time; queued messages show a `○ queued` indicator
- **Multi-line input** — end a line with `\` to continue on the next line

### Commands

Send these from your phone or type them in the terminal:

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/commands` | Show available commands |
| `/new` | `/reset` | Start a new conversation (fresh session) |
| `/compact` | — | Summarize context and start a fresh session with the summary |
| `/status` | — | Show session ID, model, directory, message count, cost, uptime |
| `/model <name>` | — | Switch model (e.g. `/model opus`) |
| `/dir <path>` | `/cd` | Change working directory |
| `/cost` | — | Show cost and API time breakdown |
| `/resume <id>` | — | Resume a previous session by ID |
| `/whoami` | — | Show your contact info |

## Library API

The package exports its core components for programmatic use:

```typescript
import { IMessageDatabase } from "clawty";
import { sendIMessage, verifySendPermission } from "clawty";
import { verifyClaudeInstalled } from "clawty";
import type { IMessage } from "clawty";
```

## Security

- Runs with `--dangerously-skip-permissions` by default — the `--permission-mode` flag can override this
- Only messages from the **single configured contact** are processed
- Group chats are filtered out
- Message content is never embedded in script strings — always written to temp files first
- SQL queries are parameterized — no string interpolation
- Echo detection prevents the bridge from responding to its own messages

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `authorization denied` when starting | Grant Full Disk Access to your terminal, then **restart it** |
| `Cannot connect to Messages.app` | Open Messages.app, sign in to iMessage, allow Automation permission |
| `Claude Code CLI not found` | Run `npm i -g @anthropic-ai/claude-code` and verify `claude --version` |
| Messages not detected | Verify the contact format matches (e.g., `+1` prefix for US numbers) |
| Response never arrives | Check the terminal for errors — Claude may have timed out or errored |

## Disclaimer

Clawty is provided "as is", without warranty of any kind, express or implied. The owners, authors, and maintainers of Clawty are not responsible for any damages, data loss, unintended messages, API charges, security vulnerabilities, or any other consequences resulting from the use of this software. You use Clawty entirely at your own risk.

This software grants an AI model access to your filesystem and the ability to execute arbitrary commands. It reads your iMessage database and sends messages on your behalf. There may be undiscovered security vulnerabilities. By using Clawty, you accept full responsibility for ensuring appropriate permissions, compliance with applicable laws, and any costs or consequences incurred.

## License

MIT
