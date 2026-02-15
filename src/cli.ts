#!/usr/bin/env bun
/**
 * iMessage <-> Claude Code bridge.
 *
 * Polls chat.db for new iMessages, sends them to Claude Code via
 * `claude -p` with streaming JSON output, and sends responses back via iMessage.
 *
 * Shows full visibility: thinking, tool calls, MCP calls, costs.
 * Uses --session-id / --resume to maintain a persistent conversation.
 * Supports slash commands via iMessage (e.g. /new, /compact, /status).
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { verifySendPermission, sendIMessage } from "./imessage/sender.ts";
import { verifyClaudeInstalled } from "./claude/runner.ts";
import { IMessageDatabase } from "./imessage/database.ts";
import type { IMessage } from "./imessage/types.ts";

// --- Styles ---

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const BRIGHT_MAGENTA = "\x1b[95m";
const BRIGHT_CYAN = "\x1b[96m";
const WHITE = "\x1b[37m";
const BG_BRIGHT_MAGENTA = "\x1b[105m";
const BG_RESET = "\x1b[49m";
const UNDERLINE = "\x1b[4m";
const NO_UNDERLINE = "\x1b[24m";
const NO_BOLD = "\x1b[22m";
const NO_ITALIC = "\x1b[23m";
const NO_DIM = "\x1b[22m"; // same SGR as no-bold; resets "intensity"

// --- Streaming Markdown → ANSI renderer ---

/**
 * Converts markdown to ANSI escape codes in a streaming-friendly way.
 * Handles bold, italic, inline code, fenced code blocks, headers, lists,
 * horizontal rules, and links — similar to how Claude Code renders output.
 */
class MarkdownRenderer {
  private pending = "";      // un-emitted chars that might start a token
  private bold = false;
  private italic = false;
  private inCode = false;    // inline `code`
  private inCodeBlock = false;
  private codeBlockTicks = 0; // number of backticks that opened the block
  private atLineStart = true;
  private lineContent = "";  // content on the current line (for HR detection)

  /** Feed a chunk of text, get back ANSI-formatted output. */
  push(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < input.length) {
      // --- Fenced code blocks (``` or ~~~) ---
      if (this.atLineStart && !this.inCode && !this.inCodeBlock) {
        const fence = this.matchFence(input, i);
        if (fence > 0) {
          // opening fence
          this.inCodeBlock = true;
          this.codeBlockTicks = fence;
          // skip to end of line (language tag)
          const nl = input.indexOf("\n", i + fence);
          if (nl === -1) { this.pending = input.slice(i); break; }
          out += `${DIM}`;
          i = nl + 1;
          this.atLineStart = true;
          this.lineContent = "";
          continue;
        }
      }

      if (this.inCodeBlock) {
        // check for closing fence
        if (this.atLineStart) {
          const fence = this.matchFence(input, i);
          if (fence >= this.codeBlockTicks) {
            this.inCodeBlock = false;
            out += RESET;
            // skip to end of fence line
            const nl = input.indexOf("\n", i + fence);
            if (nl === -1) { i = input.length; } else { i = nl + 1; }
            this.atLineStart = true;
            this.lineContent = "";
            continue;
          }
        }
        // inside code block — pass through as dim text
        if (input[i] === "\n") {
          out += "\n";
          this.atLineStart = true;
          this.lineContent = "";
        } else {
          out += input[i];
          this.atLineStart = false;
          this.lineContent += input[i];
        }
        i++;
        continue;
      }

      // --- Inline code ---
      if (input[i] === "`" && !this.inCodeBlock) {
        this.inCode = !this.inCode;
        out += this.inCode ? CYAN : RESET;
        // restore active styles after closing code
        if (!this.inCode) {
          if (this.bold) out += BOLD;
          if (this.italic) out += ITALIC;
        }
        i++;
        this.atLineStart = false;
        continue;
      }

      // Inside inline code — pass through literally
      if (this.inCode) {
        if (input[i] === "\n") {
          out += "\n";
          this.atLineStart = true;
          this.lineContent = "";
        } else {
          out += input[i];
          this.atLineStart = false;
        }
        i++;
        continue;
      }

      // --- Headers at line start: # ... ---
      if (this.atLineStart && input[i] === "#") {
        let level = 0;
        let j = i;
        while (j < input.length && input[j] === "#") { level++; j++; }
        if (j >= input.length) { this.pending = input.slice(i); break; }
        if (input[j] === " ") {
          j++; // skip space after #
          const nl = input.indexOf("\n", j);
          if (nl === -1) { this.pending = input.slice(i); break; }
          out += `${BOLD}${input.slice(j, nl)}${RESET}`;
          if (this.bold) out += BOLD;
          if (this.italic) out += ITALIC;
          out += "\n";
          i = nl + 1;
          this.atLineStart = true;
          this.lineContent = "";
          continue;
        }
      }

      // --- Horizontal rule (---, ***, ___) at line start ---
      if (this.atLineStart && (input[i] === "-" || input[i] === "*" || input[i] === "_")) {
        const ruleChar = input[i]!;
        let j = i;
        let count = 0;
        let isRule = true;
        while (j < input.length && input[j] !== "\n") {
          if (input[j] === ruleChar) count++;
          else if (input[j] !== " ") { isRule = false; break; }
          j++;
        }
        if (j >= input.length && count < 3) { this.pending = input.slice(i); break; }
        if (isRule && count >= 3 && (j < input.length || count >= 3)) {
          const cols = process.stdout.columns || 80;
          const ruleWidth = Math.min(cols - 20, 40); // leave room for indent
          out += `${DIM}${"─".repeat(ruleWidth)}${RESET}`;
          if (this.bold) out += BOLD;
          if (this.italic) out += ITALIC;
          if (j < input.length) { out += "\n"; i = j + 1; }
          else i = j;
          this.atLineStart = true;
          this.lineContent = "";
          continue;
        }
      }

      // --- List items at line start: - item, * item, N. item ---
      if (this.atLineStart && input[i] === "-" && i + 1 < input.length && input[i + 1] === " ") {
        out += `${DIM}•${RESET} `;
        if (this.bold) out += BOLD;
        if (this.italic) out += ITALIC;
        i += 2;
        this.atLineStart = false;
        this.lineContent = "• ";
        continue;
      }
      if (this.atLineStart && input[i] === "*" && i + 1 < input.length && input[i + 1] === " ") {
        // Only treat as list item if not potentially bold (**)
        if (i + 1 < input.length && input[i + 1] === " ") {
          out += `${DIM}•${RESET} `;
          if (this.bold) out += BOLD;
          if (this.italic) out += ITALIC;
          i += 2;
          this.atLineStart = false;
          this.lineContent = "• ";
          continue;
        }
      }
      if (this.atLineStart && input[i]! >= "0" && input[i]! <= "9") {
        let j = i;
        while (j < input.length && input[j]! >= "0" && input[j]! <= "9") j++;
        if (j < input.length && input[j] === "." && j + 1 < input.length && input[j + 1] === " ") {
          const num = input.slice(i, j);
          out += `${DIM}${num}.${RESET} `;
          if (this.bold) out += BOLD;
          if (this.italic) out += ITALIC;
          i = j + 2;
          this.atLineStart = false;
          this.lineContent = `${num}. `;
          continue;
        }
      }

      // --- Bold **text** ---
      if (input[i] === "*" && i + 1 < input.length && input[i + 1] === "*") {
        this.bold = !this.bold;
        out += this.bold ? BOLD : NO_BOLD;
        // re-apply italic if active (NO_BOLD resets intensity)
        if (!this.bold && this.italic) out += ITALIC;
        i += 2;
        this.atLineStart = false;
        continue;
      }

      // --- Italic *text* ---
      if (input[i] === "*") {
        // might be start of ** — buffer if at end of input
        if (i === input.length - 1) { this.pending = "*"; break; }
        this.italic = !this.italic;
        out += this.italic ? ITALIC : NO_ITALIC;
        i++;
        this.atLineStart = false;
        continue;
      }

      // --- Links [text](url) ---
      if (input[i] === "[") {
        const closeBracket = input.indexOf("]", i + 1);
        if (closeBracket === -1) {
          if (input.length - i < 200) { this.pending = input.slice(i); break; }
          // too far — treat as literal
        } else if (closeBracket + 1 < input.length && input[closeBracket + 1] === "(") {
          const closeParen = input.indexOf(")", closeBracket + 2);
          if (closeParen === -1) {
            if (input.length - i < 500) { this.pending = input.slice(i); break; }
          } else {
            const linkText = input.slice(i + 1, closeBracket);
            const url = input.slice(closeBracket + 2, closeParen);
            out += `${UNDERLINE}${linkText}${NO_UNDERLINE}${DIM} (${url})${RESET}`;
            if (this.bold) out += BOLD;
            if (this.italic) out += ITALIC;
            i = closeParen + 1;
            this.atLineStart = false;
            continue;
          }
        } else {
          // just a bracket, not a link
        }
        // fall through to literal output
      }

      // --- Newlines ---
      if (input[i] === "\n") {
        out += "\n";
        this.atLineStart = true;
        this.lineContent = "";
        i++;
        continue;
      }

      // --- Literal character ---
      out += input[i];
      this.atLineStart = false;
      this.lineContent += input[i];
      i++;
    }

    return out;
  }

  /** Flush any buffered pending chars and close open styles. */
  flush(): string {
    let out = this.pending;
    this.pending = "";
    if (this.bold || this.italic || this.inCode || this.inCodeBlock) {
      out += RESET;
    }
    this.bold = false;
    this.italic = false;
    this.inCode = false;
    this.inCodeBlock = false;
    this.atLineStart = true;
    this.lineContent = "";
    return out;
  }

  /** Check if a ``` or ~~~ fence starts at position i. Returns fence length or 0. */
  private matchFence(input: string, i: number): number {
    const ch = input[i];
    if (ch !== "`" && ch !== "~") return 0;
    let count = 0;
    let j = i;
    while (j < input.length && input[j] === ch) { count++; j++; }
    return count >= 3 ? count : 0;
  }
}

// --- Args ---

interface CliArgs {
  contact: string;
  dir: string;
  model: string;
  interval: number;
  permissionMode: string;
}

function printUsage(): void {
  console.log(`
  ${BRIGHT_MAGENTA}\u2726${RESET}  ${BOLD}iMessage ${BRIGHT_MAGENTA}\u2194${RESET}${BOLD} Claude Code${RESET}
     ${DIM}Text Claude Code from your phone via iMessage${RESET}

  ${BOLD}Usage${RESET}  ${DIM}imessage-claude [options]${RESET}

  ${BOLD}Options${RESET}
    ${BRIGHT_MAGENTA}--contact, -c${RESET} ${DIM}<phone|email>${RESET}   Contact to bridge with ${DIM}(required)${RESET}
    ${BRIGHT_MAGENTA}--dir, -d${RESET}     ${DIM}<path>${RESET}           Working directory for Claude Code
    ${BRIGHT_MAGENTA}--model, -m${RESET}   ${DIM}<model>${RESET}          Claude model ${DIM}(e.g. sonnet, opus, haiku)${RESET}
    ${BRIGHT_MAGENTA}--interval, -i${RESET} ${DIM}<ms>${RESET}           Poll interval in ms ${DIM}(default: 2000)${RESET}
    ${BRIGHT_MAGENTA}--permission-mode${RESET} ${DIM}<mode>${RESET}       Permission mode ${DIM}(default: bypassPermissions)${RESET}
    ${BRIGHT_MAGENTA}--help, -h${RESET}                     Show this help
`);
}

function parseArgs(args: string[]): CliArgs {
  let contact = "";
  let dir = process.cwd();
  let model = "";
  let interval = 2000;
  let permissionMode = "bypassPermissions";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--contact":
      case "-c":
        contact = args[++i] ?? "";
        break;
      case "--dir":
      case "-d":
        dir = args[++i] ?? process.cwd();
        break;
      case "--model":
      case "-m":
        model = args[++i] ?? "";
        break;
      case "--interval":
      case "-i":
        interval = parseInt(args[++i] ?? "2000", 10) || 2000;
        break;
      case "--permission-mode":
        permissionMode = args[++i] ?? "bypassPermissions";
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }

  return { contact, dir, model, interval, permissionMode };
}

// --- Session state (mutable, shared across the polling loop) ---

interface SessionState {
  sessionId: string;
  isFirstMessage: boolean;
  model: string;
  workingDir: string;
  messageCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  startedAt: Date;
  compactSummary: string;
}

// --- System prompt ---

function buildSystemPrompt(contact: string, compactSummary?: string): string {
  const parts = [
    "You are being contacted via iMessage.",
    `The user is texting you from their phone (${contact}).`,
    "Keep responses concise and mobile-friendly when possible.",
    "You have full access to the working directory.",
  ];
  if (compactSummary) {
    parts.push(
      `\n\nContext from previous conversation (compacted):\n${compactSummary}`,
    );
  }
  return parts.join(" ");
}

// --- Banner ---

function printBanner(args: CliArgs, workingDir: string): void {
  console.log("");
  console.log(
    `  ${BRIGHT_MAGENTA}\u2726${RESET}  ${BOLD}iMessage ${BRIGHT_MAGENTA}\u2194${RESET}${BOLD} Claude Code${RESET}`,
  );
  console.log(
    `     ${DIM}Text Claude from your phone \u2022 Type below or send via iMessage${RESET}`,
  );
  console.log("");
  console.log(
    `  ${GREEN}\u2713${RESET} Contact      ${BOLD}${args.contact}${RESET}`,
  );
  console.log(
    `  ${GREEN}\u2713${RESET} Directory    ${DIM}${workingDir}${RESET}`,
  );
  console.log(
    `  ${GREEN}\u2713${RESET} Model        ${DIM}${args.model || "(default)"}${RESET}`,
  );
  console.log(
    `  ${GREEN}\u2713${RESET} Permissions  ${DIM}--dangerously-skip-permissions${RESET}`,
  );
  console.log("");
  console.log(
    `  ${YELLOW}\u26A0  Claude can execute code, edit files, and run commands without confirmation.${RESET}`,
  );
  console.log(
    `  ${DIM}   Only use with trusted contacts and directories.${RESET}`,
  );
  console.log("");
  console.log(
    `  ${DIM}Disclaimer: Clawty is provided "as is". The owners and maintainers are not${RESET}`,
  );
  console.log(
    `  ${DIM}responsible for any damages, data loss, messages sent, API charges, or${RESET}`,
  );
  console.log(
    `  ${DIM}security vulnerabilities. There may be bugs. Use entirely at your own risk.${RESET}`,
  );
  console.log("");
}

// --- Slash commands ---

const HELP_TEXT = `Available commands:
/help — Show this help
/new — Start a new conversation (fresh session)
/compact — Compact context into a fresh session
/status — Show session info & stats
/model <name> — Switch model (e.g. /model opus)
/dir <path> — Change working directory
/cost — Show cost breakdown
/resume <id> — Resume a previous session by ID`;

interface CommandResult {
  handled: boolean;
  reply: string | null;
  sendToClaude: boolean;
  claudeMessage?: string;
}

function handleSlashCommand(
  text: string,
  session: SessionState,
  args: CliArgs,
): CommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false, reply: null, sendToClaude: true };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const rest = parts.slice(1).join(" ");

  switch (cmd) {
    case "/help":
    case "/commands":
      return { handled: true, reply: HELP_TEXT, sendToClaude: false };

    case "/new":
    case "/reset": {
      const oldId = session.sessionId.slice(0, 8);
      session.sessionId = crypto.randomUUID();
      session.isFirstMessage = true;
      session.messageCount = 0;
      session.totalCostUsd = 0;
      session.totalDurationMs = 0;
      session.startedAt = new Date();
      const newId = session.sessionId.slice(0, 8);
      console.log(
        `  ${GREEN}\u2713${RESET} New session: ${DIM}${oldId}... \u2192 ${newId}...${RESET}`,
      );
      return {
        handled: true,
        reply: `\u2726 New session started (${newId}...).\nPrevious session (${oldId}...) ended.\nSend a message to begin.`,
        sendToClaude: false,
      };
    }

    case "/compact":
      // Flag that we want to compact — the main loop will handle the two-step process
      console.log(
        `  ${YELLOW}\u26A0${RESET} Compacting context...`,
      );
      return {
        handled: true,
        reply: null,
        sendToClaude: true,
        claudeMessage: "COMPACT_CONTEXT",
      };

    case "/status": {
      const uptime = Math.floor(
        (Date.now() - session.startedAt.getTime()) / 1000,
      );
      const uptimeStr = formatDuration(uptime);
      const costStr = session.totalCostUsd > 0
        ? `$${session.totalCostUsd.toFixed(4)}`
        : "$0.00";
      const reply = [
        `\u2726 Bridge Status`,
        `Session: ${session.sessionId.slice(0, 8)}...`,
        `Model: ${session.model || args.model || "(default)"}`,
        `Directory: ${session.workingDir}`,
        `Messages: ${session.messageCount}`,
        `Total cost: ${costStr}`,
        `Uptime: ${uptimeStr}`,
        `First message: ${session.isFirstMessage ? "yes (no context yet)" : "no (session active)"}`,
      ].join("\n");
      return { handled: true, reply, sendToClaude: false };
    }

    case "/model": {
      if (!rest) {
        const current = session.model || args.model || "(default)";
        return {
          handled: true,
          reply: `Current model: ${current}\nUsage: /model <name>\nExamples: /model opus, /model sonnet, /model haiku`,
          sendToClaude: false,
        };
      }
      const oldModel = session.model || args.model || "(default)";
      session.model = rest;
      args.model = rest;
      console.log(
        `  ${GREEN}\u2713${RESET} Model: ${DIM}${oldModel} \u2192 ${rest}${RESET}`,
      );
      return {
        handled: true,
        reply: `Model switched: ${oldModel} \u2192 ${rest}`,
        sendToClaude: false,
      };
    }

    case "/dir":
    case "/cd": {
      if (!rest) {
        return {
          handled: true,
          reply: `Current directory: ${session.workingDir}\nUsage: /dir <path>`,
          sendToClaude: false,
        };
      }
      const newDir = resolve(rest.replace(/^~/, process.env.HOME ?? "~"));
      if (!existsSync(newDir)) {
        return {
          handled: true,
          reply: `Directory not found: ${newDir}`,
          sendToClaude: false,
        };
      }
      const oldDir = session.workingDir;
      session.workingDir = newDir;
      console.log(
        `  ${GREEN}\u2713${RESET} Dir: ${DIM}${oldDir} \u2192 ${newDir}${RESET}`,
      );
      return {
        handled: true,
        reply: `Working directory changed:\n${oldDir} \u2192 ${newDir}`,
        sendToClaude: false,
      };
    }

    case "/cost": {
      const costStr = session.totalCostUsd > 0
        ? `$${session.totalCostUsd.toFixed(4)}`
        : "$0.00";
      const durationStr = formatDuration(
        Math.floor(session.totalDurationMs / 1000),
      );
      return {
        handled: true,
        reply: `\u2726 Cost: ${costStr} over ${session.messageCount} messages (${durationStr} API time)`,
        sendToClaude: false,
      };
    }

    case "/resume": {
      if (!rest) {
        return {
          handled: true,
          reply: `Usage: /resume <session-id>\nCurrent session: ${session.sessionId}`,
          sendToClaude: false,
        };
      }
      const oldId = session.sessionId.slice(0, 8);
      session.sessionId = rest;
      session.isFirstMessage = false; // resuming means it's not the first message
      console.log(
        `  ${GREEN}\u2713${RESET} Resumed session: ${DIM}${oldId}... \u2192 ${rest.slice(0, 8)}...${RESET}`,
      );
      return {
        handled: true,
        reply: `Resumed session ${rest.slice(0, 8)}...\nSend a message to continue.`,
        sendToClaude: false,
      };
    }

    case "/whoami":
      return {
        handled: true,
        reply: `You are ${args.contact}, talking to Claude Code via iMessage bridge.`,
        sendToClaude: false,
      };

    default:
      return {
        handled: true,
        reply: `Unknown command: ${cmd}\nType /help for available commands.`,
        sendToClaude: false,
      };
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// --- Streaming output writer (set from main() to handle scroll region) ---
// Before main() sets this, it just writes directly.
let writeOutput: (text: string) => void = (text) => process.stdout.write(text);

// --- Streaming JSON display ---

interface StreamState {
  currentThinkingText: string;
  thinkingPrinted: boolean;
  currentToolName: string;
  currentToolInput: string;
  currentTextChunks: string[];
  textStarted: boolean;
  assistantCol: number;
  resultText: string;
  totalCost: number;
  numTurns: number;
  durationMs: number;
  sessionId: string;
  model: string;
  mdRenderer: MarkdownRenderer;
}

function newStreamState(): StreamState {
  return {
    currentThinkingText: "",
    thinkingPrinted: false,
    currentToolName: "",
    currentToolInput: "",
    currentTextChunks: [],
    textStarted: false,
    assistantCol: 0,
    resultText: "",
    totalCost: 0,
    numTurns: 0,
    durationMs: 0,
    sessionId: "",
    model: "",
    mdRenderer: new MarkdownRenderer(),
  };
}

function handleSystemInit(data: any, state: StreamState): void {
  state.sessionId = data.session_id ?? "";
  state.model = data.model ?? "";
  const tools = (data.tools ?? []) as string[];
  const mcpServers = (data.mcp_servers ?? []) as any[];
  const version = data.claude_code_version ?? "";

  console.log(
    `  ${DIM}\u250C\u2500 Session ${state.sessionId.slice(0, 8)}... \u2502 ${state.model} \u2502 v${version}${RESET}`,
  );

  if (mcpServers.length > 0) {
    const connected = mcpServers
      .filter((s: any) => s.status === "connected")
      .map((s: any) => s.name);
    if (connected.length > 0) {
      console.log(
        `  ${DIM}\u2502  MCP: ${connected.join(", ")}${RESET}`,
      );
    }
  }

  const mcpTools = tools.filter((t: string) => t.startsWith("mcp__"));
  const builtinTools = tools.filter((t: string) => !t.startsWith("mcp__"));
  console.log(
    `  ${DIM}\u2502  Tools: ${builtinTools.length} built-in, ${mcpTools.length} MCP${RESET}`,
  );
}

const ASSISTANT_INDENT = "                "; // 16 spaces — aligns with text after "  ◀ [assistant] "

/** Wrap text for assistant output, respecting terminal width and indentation. */
function wrapAssistantText(
  text: string,
  startCol: number,
): { wrapped: string; endCol: number } {
  const cols = process.stdout.columns || 80;
  let col = startCol;
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\x1b") {
      // Pass through ANSI escape sequences without counting columns
      result += ch;
      i++;
      if (i < text.length && text[i] === "[") {
        result += text[i]!;
        i++;
        while (
          i < text.length &&
          text.charCodeAt(i) >= 0x20 &&
          text.charCodeAt(i) <= 0x3f
        ) {
          result += text[i]!;
          i++;
        }
        if (i < text.length) result += text[i]!;
      }
    } else if (ch === "\n") {
      result += "\n" + ASSISTANT_INDENT;
      col = ASSISTANT_INDENT.length;
    } else {
      if (col >= cols) {
        result += "\n" + ASSISTANT_INDENT;
        col = ASSISTANT_INDENT.length;
      }
      result += ch;
      col++;
    }
  }

  return { wrapped: result, endCol: col };
}

function handleStreamEvent(event: any, state: StreamState): void {
  const etype = event.type;

  if (etype === "content_block_start") {
    const block = event.content_block ?? {};
    if (block.type === "thinking") {
      state.currentThinkingText = "";
      state.thinkingPrinted = false;
    } else if (block.type === "tool_use") {
      state.currentToolName = block.name ?? "";
      state.currentToolInput = "";
    }
  } else if (etype === "content_block_delta") {
    const delta = event.delta ?? {};
    if (delta.type === "thinking_delta") {
      const chunk = delta.thinking ?? "";
      state.currentThinkingText += chunk;
      if (!state.thinkingPrinted) {
        state.thinkingPrinted = true;
        writeOutput(
          `  ${MAGENTA}${ITALIC}  thinking...${RESET} `,
        );
      }
      if (state.currentThinkingText.length % 100 < chunk.length) {
        writeOutput(`${DIM}.${RESET}`);
      }
    } else if (delta.type === "input_json_delta") {
      state.currentToolInput += delta.partial_json ?? "";
    } else if (delta.type === "text_delta") {
      const text = delta.text ?? "";
      if (!state.textStarted) {
        state.textStarted = true;
        state.assistantCol = ASSISTANT_INDENT.length;
        writeOutput(
          `  ${RED}\u25C0${RESET} ${DIM}[assistant]${RESET} `,
        );
      }
      state.currentTextChunks.push(text);
      const rendered = state.mdRenderer.push(text);
      const { wrapped, endCol } = wrapAssistantText(rendered, state.assistantCol);
      state.assistantCol = endCol;
      writeOutput(wrapped);
    }
  } else if (etype === "content_block_stop") {
    // Flush any buffered markdown tokens from the text stream
    if (state.textStarted) {
      const trailing = state.mdRenderer.flush();
      if (trailing) {
        const { wrapped, endCol } = wrapAssistantText(trailing, state.assistantCol);
        state.assistantCol = endCol;
        writeOutput(wrapped);
      }
    }
    if (state.thinkingPrinted) {
      const lines = state.currentThinkingText.split("\n").length;
      console.log(
        ` ${DIM}(${state.currentThinkingText.length} chars, ${lines} lines)${RESET}`,
      );
      const preview = state.currentThinkingText.split("\n").slice(0, 3);
      for (const line of preview) {
        if (line.trim()) {
          console.log(
            `  ${DIM}${MAGENTA}  \u2502 ${line.trim().slice(0, 120)}${RESET}`,
          );
        }
      }
      if (state.currentThinkingText.split("\n").length > 3) {
        console.log(
          `  ${DIM}${MAGENTA}  \u2502 ...${RESET}`,
        );
      }
      state.currentThinkingText = "";
      state.thinkingPrinted = false;
    }
  }
  // Intentionally NOT logging message_delta context_management here —
  // it fires on every turn even when nothing was compacted.
}

function handleAssistantMessage(data: any, state: StreamState): void {
  const msg = data.message ?? {};
  const content = msg.content ?? [];

  for (const block of content) {
    if (block.type === "thinking" && block.thinking) {
      const text = block.thinking as string;
      const lines = text.split("\n").length;
      console.log(
        `  ${MAGENTA}${ITALIC}  thinking${RESET} ${DIM}(${text.length} chars, ${lines} lines)${RESET}`,
      );
      const preview = text.split("\n").slice(0, 3);
      for (const line of preview) {
        if (line.trim()) {
          console.log(
            `  ${DIM}${MAGENTA}  \u2502 ${line.trim().slice(0, 120)}${RESET}`,
          );
        }
      }
      if (lines > 3) {
        console.log(
          `  ${DIM}${MAGENTA}  \u2502 ...${RESET}`,
        );
      }
    } else if (block.type === "tool_use") {
      const name = block.name ?? "unknown";
      const input = block.input ?? {};
      const isMcp = name.startsWith("mcp__");
      const color = isMcp ? BRIGHT_CYAN : CYAN;
      const label = isMcp ? "MCP Tool" : "Tool";

      console.log(
        `  ${color}\u25B6 ${label}: ${BOLD}${name}${RESET}`,
      );

      const inputStr = formatToolInput(name, input);
      if (inputStr) {
        console.log(`    ${DIM}${inputStr}${RESET}`);
      }
    } else if (block.type === "text") {
      const text = block.text ?? "";
      if (text) {
        if (state.currentTextChunks.length === 0) {
          // Non-streamed text block — render markdown and show with assistant label
          const rendered = state.mdRenderer.push(text) + state.mdRenderer.flush();
          const { wrapped } = wrapAssistantText(rendered, ASSISTANT_INDENT.length);
          console.log(`  ${RED}\u25C0${RESET} ${DIM}[assistant]${RESET} ${wrapped}`);
        } else {
          // Already streamed via text_delta — just close the line
          console.log("");
        }
        state.currentTextChunks = [];
        state.textStarted = false;
        state.mdRenderer = new MarkdownRenderer();
      }
    }
  }

  // Context management is handled by /compact command; don't log API-level events
  // as they fire on every turn even when nothing was actually compacted.
}

function handleToolResult(data: any): void {
  const toolResult = data.tool_use_result;
  if (!toolResult) return;

  const stdout = toolResult.stdout ?? "";
  const stderr = toolResult.stderr ?? "";
  const isError = toolResult.is_error ?? false;
  const isImage = toolResult.isImage ?? false;

  if (isImage) {
    console.log(`    ${DIM}\u2192 [image result]${RESET}`);
    return;
  }

  if (isError) {
    const errText = stderr || stdout;
    const preview = errText.split("\n").slice(0, 3).join("\n    ");
    console.log(`    ${RED}\u2192 Error: ${preview.slice(0, 200)}${RESET}`);
    return;
  }

  const output = stdout || "";
  if (output) {
    const lines = output.split("\n");
    const preview = lines.slice(0, 5);
    for (const line of preview) {
      console.log(`    ${DIM}\u2192 ${line.slice(0, 150)}${RESET}`);
    }
    if (lines.length > 5) {
      console.log(
        `    ${DIM}\u2192 ... (${lines.length - 5} more lines)${RESET}`,
      );
    }
  }
}

function handleResult(data: any, state: StreamState): void {
  state.resultText = data.result ?? "";
  state.totalCost = data.total_cost_usd ?? 0;
  state.numTurns = data.num_turns ?? 0;
  state.durationMs = data.duration_ms ?? 0;

  const costStr =
    state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : "";
  const durationStr =
    state.durationMs > 0 ? `${(state.durationMs / 1000).toFixed(1)}s` : "";

  console.log(
    `  ${DIM}\u2514\u2500 ${state.numTurns} turn${state.numTurns !== 1 ? "s" : ""} \u2502 ${durationStr} \u2502 ${costStr}${RESET}`,
  );
}

function formatToolInput(name: string, input: any): string {
  if (name === "Bash" || name === "bash") {
    return input.command
      ? `$ ${(input.command as string).slice(0, 150)}`
      : "";
  }
  if (name === "Read" || name === "read") {
    return input.file_path ? `file: ${input.file_path}` : "";
  }
  if (name === "Write" || name === "write") {
    return input.file_path ? `file: ${input.file_path}` : "";
  }
  if (name === "Edit" || name === "edit") {
    return input.file_path ? `file: ${input.file_path}` : "";
  }
  if (name === "Glob" || name === "glob") {
    return input.pattern ? `pattern: ${input.pattern}` : "";
  }
  if (name === "Grep" || name === "grep") {
    return input.pattern ? `pattern: ${input.pattern}` : "";
  }
  if (name === "WebFetch") {
    return input.url ? `url: ${input.url}` : "";
  }
  if (name === "WebSearch") {
    return input.query ? `query: ${input.query}` : "";
  }
  if (name === "Task") {
    return input.description
      ? `task: ${input.description}`
      : input.prompt
        ? `prompt: ${(input.prompt as string).slice(0, 100)}`
        : "";
  }

  // MCP tools — show first meaningful param
  if (name.startsWith("mcp__")) {
    const keys = Object.keys(input).filter(
      (k) => input[k] !== null && input[k] !== undefined && input[k] !== "",
    );
    if (keys.length > 0) {
      const first = keys[0]!;
      const val = String(input[first]).slice(0, 120);
      return `${first}: ${val}`;
    }
  }

  // Fallback: compact JSON
  const str = JSON.stringify(input);
  return str.length > 2 ? str.slice(0, 150) : "";
}

// --- Claude streaming subprocess ---

async function resolveClaudePath(): Promise<string> {
  const proc = Bun.spawn(["which", "claude"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim() || "claude";
}

async function runClaudeStreaming(
  claudePath: string,
  message: string,
  session: SessionState,
  args: CliArgs,
  onFirstOutput?: () => void,
): Promise<{ text: string; cost: number; durationMs: number }> {
  const cmd: string[] = [
    claudePath,
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  if (session.isFirstMessage) {
    cmd.push("--session-id", session.sessionId);
    cmd.push("--append-system-prompt", buildSystemPrompt(args.contact, session.compactSummary));
  } else {
    cmd.push("-r", session.sessionId);
  }

  if (args.model) {
    cmd.push("--model", args.model);
  }

  if (args.permissionMode && args.permissionMode !== "bypassPermissions") {
    cmd.push("--permission-mode", args.permissionMode);
  }

  const proc = Bun.spawn(cmd, {
    cwd: session.workingDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: "", // Avoid nested session guard
    },
  });

  const state = newStreamState();
  let resultText = "";
  let cost = 0;
  let durationMs = 0;
  let firstOutputFired = false;

  // Read stderr in background
  const stderrPromise = new Response(proc.stderr).text();

  // Process stdout line by line as NDJSON
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const data = JSON.parse(line);
        const type = data.type as string;

        if (!firstOutputFired) {
          firstOutputFired = true;
          onFirstOutput?.();
        }

        switch (type) {
          case "system":
            if (data.subtype === "init") {
              handleSystemInit(data, state);
              // Update session model from what Claude actually used
              if (data.model) session.model = data.model;
            }
            break;

          case "stream_event":
            handleStreamEvent(data.event ?? {}, state);
            break;

          case "assistant":
            handleAssistantMessage(data, state);
            break;

          case "user":
            handleToolResult(data);
            break;

          case "result":
            handleResult(data, state);
            resultText = data.result ?? "";
            cost = data.total_cost_usd ?? 0;
            durationMs = data.duration_ms ?? 0;
            break;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  const exitCode = await proc.exited;
  const stderr = await stderrPromise;

  if (exitCode !== 0 && !resultText) {
    const errMsg = stderr.trim() || `claude exited with code ${exitCode}`;
    throw new Error(errMsg);
  }

  return { text: resultText, cost, durationMs };
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Single stdin reader — used for both the contact prompt and ongoing input
  const stdinReader = Bun.stdin.stream().getReader();
  const stdinDecoder = new TextDecoder();
  let stdinBuf = "";

  // Helper: read one line from stdin
  async function readLine(): Promise<string> {
    while (true) {
      const nl = stdinBuf.indexOf("\n");
      if (nl !== -1) {
        const line = stdinBuf.slice(0, nl).trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        return line;
      }
      const { done, value } = await stdinReader.read();
      if (done) return stdinBuf.trim();
      stdinBuf += stdinDecoder.decode(value, { stream: true });
    }
  }

  if (!args.contact) {
    console.log("");
    console.log(
      `  ${BRIGHT_MAGENTA}\u2726${RESET}  ${BOLD}iMessage ${BRIGHT_MAGENTA}\u2194${RESET}${BOLD} Claude Code${RESET}`,
    );
    console.log("");
    process.stdout.write(
      `  ${BRIGHT_MAGENTA}Phone or email:${RESET} `,
    );
    const input = await readLine();
    if (!input) {
      console.error(
        `\n  ${RED}\u2717${RESET} ${RED}No contact provided.${RESET}\n`,
      );
      process.exit(1);
    }
    args.contact = input;
    // Clear the interactive prompt and continue to full banner
    process.stdout.write("\x1b[A\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K");
  }

  const workingDir = resolve(args.dir);
  if (!existsSync(workingDir)) {
    console.error(
      `  ${RED}\u2717${RESET} ${RED}Working directory does not exist: ${workingDir}${RESET}`,
    );
    process.exit(1);
  }

  if (process.platform !== "darwin") {
    console.error(
      `  ${RED}\u2717${RESET} ${RED}This tool only works on macOS (required for iMessage access)${RESET}`,
    );
    process.exit(1);
  }

  // Preflight checks
  const hasClaude = await verifyClaudeInstalled();
  if (!hasClaude) {
    console.error(
      `  ${RED}\u2717${RESET} ${RED}Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code${RESET}`,
    );
    process.exit(1);
  }

  const canSend = await verifySendPermission();
  if (!canSend) {
    console.error(
      `  ${RED}\u2717${RESET} ${RED}Cannot connect to Messages.app. Open Messages.app and allow Automation.${RESET}`,
    );
    process.exit(1);
  }

  const claudePath = await resolveClaudePath();

  // Print banner
  printBanner(args, workingDir);

  // Session state
  const session: SessionState = {
    sessionId: crypto.randomUUID(),
    isFirstMessage: true,
    model: args.model,
    workingDir,
    messageCount: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    startedAt: new Date(),
    compactSummary: "",
  };

  let processing = false;
  let promptVisible = false;

  // Signal to wake the main loop immediately when a local message arrives
  let wakeResolve: (() => void) | null = null;
  function wakeMainLoop(): void {
    if (wakeResolve) {
      wakeResolve();
      wakeResolve = null;
    }
  }
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wakeResolve = resolve;
      setTimeout(resolve, ms);
    });
  }

  // Initialize iMessage database reader
  const db = new IMessageDatabase();
  db.initialize();

  // Resolve contact to the exact handle ID in the database.
  // This handles cases like "6692333038" → "+16692333038".
  let contactResolved = false;
  function tryResolveContact(): void {
    if (contactResolved) return;
    const resolved = db.findContact(args.contact);
    if (resolved) {
      if (resolved.id !== args.contact) {
        console.log(
          `  ${GREEN}\u2713${RESET} Resolved contact ${DIM}${args.contact} \u2192 ${resolved.id}${RESET}`,
        );
        args.contact = resolved.id;
      }
      contactResolved = true;
    }
  }
  tryResolveContact();
  if (!contactResolved) {
    console.log(
      `  ${YELLOW}\u26A0${RESET} ${YELLOW}Contact "${args.contact}" not found in iMessage database yet.${RESET}`,
    );
    console.log(
      `  ${DIM}  Will keep trying — once they text you, the handle will appear.${RESET}`,
    );
  }

  // Track recently sent messages to avoid echo loops
  const recentlySent = new Map<string, number>();

  function isEcho(text: string): boolean {
    const now = Date.now();
    for (const [key, ts] of recentlySent) {
      if (now - ts > 300_000) recentlySent.delete(key);
    }
    const fingerprint = text.slice(0, 150).toLowerCase().trim();
    for (const [sent] of recentlySent) {
      if (fingerprint.startsWith(sent) || sent.startsWith(fingerprint)) {
        return true;
      }
    }
    return false;
  }

  function trackSent(text: string): void {
    const fingerprint = text.slice(0, 150).toLowerCase().trim();
    recentlySent.set(fingerprint, Date.now());
  }

  // Send startup message via iMessage
  try {
    const startupMsg = [
      "\u2726 iMessage \u2194 Claude Code bridge is active.",
      "",
      "Send a message to chat with Claude Code.",
      "Type /help for available commands.",
    ].join("\n");
    trackSent(startupMsg);
    await sendIMessage(args.contact, startupMsg);
    await db.advanceCursorWithDelay();
    console.log(
      `  ${GREEN}\u2713${RESET} Startup message sent to ${BOLD}${args.contact}${RESET}`,
    );
  } catch (e: any) {
    console.log(
      `  ${YELLOW}\u26A0${RESET} Could not send startup message: ${DIM}${e.message}${RESET}`,
    );
  }

  console.log(
    `  ${GREEN}\u2713${RESET} Session: ${DIM}${session.sessionId}${RESET}`,
  );
  console.log(
    `\n  ${DIM}Type /help for available commands${RESET}`,
  );
  console.log("");

  // Unified message queue — both local stdin and iMessages go here
  interface QueuedMessage {
    text: string;
    source: "local" | "imessage";
    sender?: string;
    time?: string;
  }
  const messageQueue: QueuedMessage[] = [];

  // Background iMessage poller — runs during processing to detect queued iMessages
  let imessagePollerTimer: ReturnType<typeof setInterval> | null = null;

  function startImessagePoller(): void {
    if (imessagePollerTimer) return;
    imessagePollerTimer = setInterval(() => {
      try {
        const messages = db.getNewMessages(args.contact);
        const incoming = messages.filter((msg) => !isEcho(msg.text));
        for (const msg of incoming) {
          const time = msg.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          messageQueue.push({ text: msg.text, source: "imessage", sender: msg.sender, time });
          const queueNum = messageQueue.length;
          const cols = process.stdout.columns || 80;
          const prefix = `  ○ queued (${queueNum} pending) [${time}] ${msg.sender}: `;
          const maxText = cols - prefix.length;
          const displayMsg = msg.text.length > maxText ? msg.text.slice(0, maxText - 1) + '\u2026' : msg.text;
          console.log(
            `  ${YELLOW}\u25CB${RESET} ${DIM}queued (${queueNum} pending)${RESET} ${DIM}[${time}]${RESET} ${BOLD}${msg.sender}${RESET}: ${displayMsg}`,
          );
        }
      } catch {
        // Ignore DB errors during background polling
      }
    }, args.interval);
  }

  function stopImessagePoller(): void {
    if (imessagePollerTimer) {
      clearInterval(imessagePollerTimer);
      imessagePollerTimer = null;
    }
  }

  // --- Raw mode input handling ---
  // We take full control of stdin so typed chars never leak into output.

  let inputBuffer = ""; // Current line being typed
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let dynamicLineCount = 0; // How many "dynamic" lines at bottom to erase before next update
  let streamingCol = 0; // Track cursor column during streaming so we can restore position

  const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

  // Enable raw mode so we control echo
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // --- Erase-and-redraw UI (Ink pattern) ---
  // Static output is written permanently and scrolls up.
  // Dynamic content (prompt, spinner) is erased and redrawn at the bottom.
  // No scroll regions. No cursor save/restore. Just erase + redraw.

  /** Erase N lines starting from cursor (going up). */
  function eraseLines(count: number): void {
    for (let i = 0; i < count; i++) {
      process.stdout.write('\x1b[2K'); // clear entire line
      if (i < count - 1) {
        process.stdout.write('\x1b[1A'); // cursor up
      }
    }
    process.stdout.write('\r'); // carriage return to col 0
  }

  // Get the visible portion of the current input line (handles multi-line)
  function getVisibleInput(): string {
    const cols = process.stdout.columns || 80;
    const maxInput = cols - 5; // "  > " or "  .. " = 4-5 chars + margin
    const lastNl = inputBuffer.lastIndexOf("\n");
    const currentLine = lastNl >= 0 ? inputBuffer.slice(lastNl + 1) : inputBuffer;
    return currentLine.length > maxInput
      ? currentLine.slice(currentLine.length - maxInput)
      : currentLine;
  }

  /** Erase dynamic section, then redraw the appropriate dynamic content. */
  function redrawPrompt(): void {
    const hadDynamic = dynamicLineCount > 0;
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
    }
    // If spinner is running, redraw spinner + prompt (not just prompt)
    if (spinnerTimer) {
      drawSpinnerAndPrompt();
      return;
    }
    // During streaming, put prompt on its own line below the streaming text.
    // If we just erased a dynamic line, cursor is already on a separate line
    // (col 0 of where the old prompt was). If not, cursor is at the end of
    // streaming text, so we need a newline first.
    if (streamingActive && !hadDynamic) {
      process.stdout.write('\n');
    }
    const inContinuation = inputBuffer.includes("\n");
    const prefix = inContinuation
      ? `  ${DIM}..${RESET} `
      : `  ${BRIGHT_MAGENTA}>${RESET} `;
    process.stdout.write(`${prefix}${getVisibleInput()}`);
    dynamicLineCount = 1;
    promptVisible = true;
  }

  /** Erase dynamic section, write permanent output, redraw dynamic section. */
  let streamingActive = false;
  function writePermanent(text: string): void {
    // Erase the current dynamic section (prompt + maybe spinner)
    const hadDynamic = dynamicLineCount > 0;
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
    }
    if (streamingActive) {
      if (hadDynamic) {
        // Prompt was on its own line below streaming text.
        // After erasing, cursor is at col 0 of where the prompt was.
        // That's fine — just write the permanent output here.
      } else {
        // No prompt was drawn, cursor is at end of streaming text.
        // Need a newline to start permanent output on a new line.
        process.stdout.write('\n');
      }
      streamingActive = false;
      streamingCol = 0;
    }
    // Write the permanent output (becomes part of scroll history)
    process.stdout.write(text + '\n');
    // Redraw the dynamic section
    if (spinnerTimer) {
      drawSpinnerAndPrompt();
    } else if (promptVisible) {
      redrawPrompt();
    }
  }

  // Override console.log/error to go through writePermanent.
  const _origLog = console.log.bind(console);
  const _origError = console.error.bind(console);
  console.log = (...args: any[]) => {
    const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
    writePermanent(text);
  };
  console.error = (...args: any[]) => {
    const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
    writePermanent(text);
  };

  /** Update streamingCol based on text just written. Skips ANSI escape sequences. */
  function updateStreamingCol(text: string): void {
    const cols = process.stdout.columns || 80;
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\x1b') {
        // Skip ANSI escape sequence: ESC [ ... <letter>
        i++;
        if (i < text.length && text[i] === '[') {
          i++;
          while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) {
            i++; // skip parameter bytes and intermediate bytes
          }
          if (i < text.length) i++; // skip final byte
        }
        continue;
      }
      if (ch === '\n') {
        streamingCol = 0;
      } else if (ch === '\r') {
        streamingCol = 0;
      } else {
        streamingCol++;
        if (streamingCol >= cols) {
          streamingCol = 0;
        }
      }
      i++;
    }
  }

  /**
   * Write streaming text directly. Erases the prompt if visible, restores cursor
   * to the streaming line, writes text, then redraws the prompt below.
   */
  function writeStreaming(text: string): void {
    // If there's a dynamic section (prompt below streaming text), erase it
    // and restore cursor to the end of the streaming text line
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
      // After erasing, cursor is at col 0 of the prompt line.
      // If streaming was active, the prompt was on its own line below the
      // streaming text — move up and restore column position.
      if (streamingActive) {
        process.stdout.write(`\x1b[1A`);  // move up to streaming line
        if (streamingCol > 0) {
          process.stdout.write(`\x1b[${streamingCol}C`);  // restore column
        }
      }
    }
    // Write the streaming text directly
    process.stdout.write(text);
    streamingActive = true;
    // Track column position for cursor restoration
    updateStreamingCol(text);
    // Redraw prompt below the streaming text
    redrawPrompt();
  }

  // Connect the global writeOutput
  writeOutput = writeStreaming;

  let spinnerFrame = 0; // Current spinner frame — shared so keystrokes don't reset it

  /** Draw spinner line + prompt line (2 dynamic lines). */
  function drawSpinnerAndPrompt(): void {
    const inC = inputBuffer.includes("\n");
    const p = inC ? `  ${DIM}..${RESET} ` : `  ${BRIGHT_MAGENTA}>${RESET} `;
    process.stdout.write(`  ${DIM}${SPINNER_FRAMES[spinnerFrame]} Thinking...${RESET}\n`);
    process.stdout.write(`${p}${getVisibleInput()}`);
    dynamicLineCount = 2;
  }

  /** Stop spinner and erase it, leaving just the prompt. */
  function clearSpinner(): void {
    stopSpinner();
    // Erase dynamic section (spinner + prompt) and redraw just prompt
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
    }
    redrawPrompt();
  }

  function startSpinner(): void {
    spinnerFrame = 0;
    streamingCol = 0;
    // Erase current dynamic section and draw spinner + prompt
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
    }
    drawSpinnerAndPrompt();

    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      // Erase the 2 dynamic lines, redraw
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
      drawSpinnerAndPrompt();
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // Read raw stdin bytes in background
  async function readStdinRaw(): Promise<void> {
    while (true) {
      // Drain leftover buffer from cooked-mode readLine
      if (stdinBuf.length > 0) {
        for (const ch of stdinBuf) {
          handleChar(ch);
        }
        stdinBuf = "";
      }

      const { done, value } = await stdinReader.read();
      if (done) break;
      const chunk = stdinDecoder.decode(value, { stream: true });
      for (const ch of chunk) {
        handleChar(ch);
      }
    }
  }

  let escapeSeq = 0; // 0=normal, 1=got ESC, 2=got ESC+[

  function handleChar(ch: string): void {
    const code = ch.charCodeAt(0);

    // Swallow escape sequences (e.g. arrow keys: ESC [ A)
    if (escapeSeq === 1) {
      escapeSeq = ch === "[" ? 2 : 0;
      return;
    }
    if (escapeSeq === 2) {
      escapeSeq = 0;
      return;
    }
    if (code === 27) {
      escapeSeq = 1;
      return;
    }

    // Ctrl+C
    if (code === 3) {
      shutdown();
      return;
    }

    // Ctrl+D on empty line
    if (code === 4 && inputBuffer.length === 0) {
      shutdown();
      return;
    }

    // Enter
    if (ch === "\r" || ch === "\n") {
      // Backslash at end = line continuation (add newline to buffer, keep typing)
      if (inputBuffer.endsWith("\\")) {
        inputBuffer = inputBuffer.slice(0, -1) + "\n";
        redrawPrompt(); // Shows ".." prefix for continuation
        return;
      }

      const line = inputBuffer.trim();
      inputBuffer = "";

      if (!line) {
        redrawPrompt();
        return;
      }

      messageQueue.push({ text: line, source: "local" });
      wakeMainLoop();

      if (processing) {
        const queueNum = messageQueue.length;
        const cols = process.stdout.columns || 80;
        const queuePrefix = `  \u25CB queued (${queueNum} pending) `;
        const maxQueueText = cols - queuePrefix.length;
        const queueDisplay = line.length > maxQueueText ? line.slice(0, maxQueueText - 1) + '\u2026' : line;

        console.log(
          `  ${YELLOW}\u25CB${RESET} ${DIM}queued (${queueNum} pending)${RESET} ${queueDisplay}`,
        );
      }

      // Redraw prompt to clear the typed text
      redrawPrompt();
      return;
    }

    // Backspace / Delete
    if (code === 127 || code === 8) {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1);
        redrawPrompt();
      }
      return;
    }

    // Ignore control characters
    if (code < 32) return;

    // Normal printable character
    inputBuffer += ch;
    redrawPrompt();
  }

  // Start reading stdin (non-blocking — runs in background)
  readStdinRaw().catch(() => {});

  // Show initial prompt
  redrawPrompt();

  // Graceful shutdown
  let running = true;

  function shutdown(): void {
    if (!running) return;
    running = false;
    stopSpinner();
    stopImessagePoller();
    if (dynamicLineCount > 0) {
      eraseLines(dynamicLineCount);
      dynamicLineCount = 0;
    }
    promptVisible = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    _origLog(`\n  ${DIM}Shutting down...${RESET}`);
    db.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // --- Process a batch of messages ---
  async function processMessages(
    messages: QueuedMessage[],
  ): Promise<void> {
    // Build combined prompt from all sources
    const parts: string[] = [];

    console.log(`${"─".repeat(60)}`);
    for (const msg of messages) {
      const cols = process.stdout.columns || 80;
      if (msg.source === "imessage") {
        const time = msg.time ?? "";
        const sender = msg.sender ?? args.contact;
        const prefixLen = 6 + time.length + sender.length + 2;
        const maxText = cols - prefixLen;
        const displayMsg = msg.text.length > maxText ? msg.text.slice(0, maxText - 1) + '\u2026' : msg.text;
        console.log(
          `  ${BRIGHT_MAGENTA}\u2726${RESET} ${DIM}[${time}]${RESET} ${BOLD}${sender}${RESET}: ${displayMsg}`,
        );
      } else {
        const displayText = msg.text.length > cols - 13 ? msg.text.slice(0, cols - 14) + '\u2026' : msg.text;
        console.log(
          `  ${GREEN}\u25B6${RESET} ${DIM}[local]${RESET} ${displayText}`,
        );
      }
      parts.push(msg.text);
    }

    const combined = parts.join("\n\n");
    console.log("");

    // Check for slash commands
    const cmdResult = handleSlashCommand(combined, session, args);

    if (cmdResult.handled && !cmdResult.sendToClaude) {
      if (cmdResult.reply) {
        // Show the response locally
        for (const line of cmdResult.reply.split("\n")) {
          console.log(`  ${RED}\u25C0${RESET} ${DIM}${line}${RESET}`);
        }
        trackSent(cmdResult.reply);
        await sendIMessage(args.contact, cmdResult.reply);
        await db.advanceCursorWithDelay();
        console.log(
          `  ${GREEN}\u2713 Command response sent${RESET}`,
        );
      }
    } else if (cmdResult.claudeMessage === "COMPACT_CONTEXT") {
      // Two-step compact: ask for summary, then start fresh session with it
      startSpinner();
      try {
        const summaryResult = await runClaudeStreaming(
          claudePath,
          "Summarize our entire conversation so far in a few concise bullet points. Include: what we're working on, key decisions, current state of the work, and any important context. Be brief but complete. Output ONLY the summary, nothing else.",
          session,
          args,
          clearSpinner,
        );
        session.totalCostUsd += summaryResult.cost;
        session.totalDurationMs += summaryResult.durationMs;

        const summary = summaryResult.text || "";
        const oldId = session.sessionId.slice(0, 8);

        // Start new session with summary baked in
        session.sessionId = crypto.randomUUID();
        session.isFirstMessage = true;
        session.compactSummary = summary;
        const newId = session.sessionId.slice(0, 8);

        console.log(
          `\n  ${GREEN}\u2713${RESET} Compacted: ${DIM}${oldId}... \u2192 ${newId}...${RESET}`,
        );

        const reply = summary
          ? `\u2726 Context compacted (${oldId}... \u2192 ${newId}...)\n\nCarried over:\n${summary}`
          : `\u2726 Context compacted (${oldId}... \u2192 ${newId}...)`;
        trackSent(reply);
        await sendIMessage(args.contact, reply);
        await db.advanceCursorWithDelay();
        console.log(
          `  ${GREEN}\u2713 Compact response sent${RESET}`,
        );
      } catch (e: any) {
        clearSpinner();
        console.error(
          `  ${RED}\u2717 Compact failed: ${e.message}${RESET}`,
        );
        try {
          await sendIMessage(
            args.contact,
            `[Compact failed: ${e.message.slice(0, 200)}]`,
          );
          await db.advanceCursorWithDelay();
        } catch {
          // Ignore
        }
      }
    } else {
      // Send to Claude (normal message or command that proxies to Claude)
      const prompt = cmdResult.claudeMessage ?? combined;
      startSpinner();

      try {
        const result = await runClaudeStreaming(
          claudePath,
          prompt,
          session,
          args,
          clearSpinner,
        );
        session.isFirstMessage = false;
        session.messageCount++;
        session.totalCostUsd += result.cost;
        session.totalDurationMs += result.durationMs;

        if (result.text) {
          console.log("");
          trackSent(result.text);
          await sendIMessage(args.contact, result.text);
          await db.advanceCursorWithDelay();
          console.log(
            `  ${GREEN}\u2713 Response sent via iMessage${RESET} ${DIM}(${result.text.length} chars)${RESET}`,
          );
        } else {
          console.log(
            `  ${YELLOW}\u26A0${RESET} ${DIM}Empty response from Claude${RESET}`,
          );
        }
      } catch (e: any) {
        clearSpinner();
        console.error(
          `  ${RED}\u2717 Error: ${e.message}${RESET}`,
        );
        try {
          await sendIMessage(
            args.contact,
            `[Error: ${e.message.slice(0, 200)}]`,
          );
          await db.advanceCursorWithDelay();
        } catch {
          // Ignore send failure for error messages
        }
      }
    }

    console.log("");
  }

  // Main polling loop
  while (running) {
    try {
      if (!processing) {
        // Retry contact resolution if not yet matched (e.g. new number)
        tryResolveContact();
        // Check iMessage DB for new messages and add to unified queue
        const dbMessages = db.getNewMessages(args.contact);
        const incoming = dbMessages.filter((msg) => !isEcho(msg.text));
        for (const msg of incoming) {
          const time = msg.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          messageQueue.push({ text: msg.text, source: "imessage", sender: msg.sender, time });
        }

        if (messageQueue.length > 0) {
          processing = true;
          startImessagePoller();

          // Drain the queue batch
          const batch: QueuedMessage[] = [];
          while (messageQueue.length > 0) {
            batch.push(messageQueue.shift()!);
          }
          await processMessages(batch);

          // Drain any messages that were queued while processing
          while (running) {
            if (messageQueue.length === 0) break;
            const nextBatch: QueuedMessage[] = [];
            while (messageQueue.length > 0) {
              nextBatch.push(messageQueue.shift()!);
            }
            await processMessages(nextBatch);
          }

          stopImessagePoller();
          processing = false;
          streamingActive = false;
          streamingCol = 0;
          // Force-draw the prompt
          redrawPrompt();
        }
      }
    } catch {
      // Silently ignore DB errors during polling
    }

    await interruptibleSleep(args.interval);
  }
}

main().catch((e) => {
  console.error(`  ${RED}\u2717${RESET} ${RED}${e.message}${RESET}`);
  process.exit(1);
});
