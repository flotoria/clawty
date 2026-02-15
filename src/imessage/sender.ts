import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";

const MAX_IMESSAGE_LENGTH = 15000;

/**
 * Remove a temp file, ignoring errors.
 */
async function cleanupTmpFile(path: string): Promise<void> {
  try { await unlink(path); } catch {}
}

/**
 * Send an iMessage using JXA (JavaScript for Automation).
 * Uses chats.whose({id: {_contains: contact}}) which is the reliable
 * approach on modern macOS (Sonoma/Sequoia). Message content is read
 * from a temp file to avoid all string escaping issues.
 */
async function sendViaJxa(contact: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const tmpFile = join(tmpdir(), `clawty-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await Bun.write(tmpFile, text);

  try {
    const jxaScript = `
ObjC.import('Foundation');
function run() {
  var filePath = ${JSON.stringify(tmpFile)};
  var contact = ${JSON.stringify(contact)};
  var nsStr = $.NSString.stringWithContentsOfFileEncodingError(filePath, $.NSUTF8StringEncoding, null);
  var message = nsStr.js;
  var app = Application("Messages");
  var chats = app.chats.whose({id: {_contains: contact}})();
  if (chats.length === 0) throw new Error("No chat found for contact: " + contact);
  app.send(message, {to: chats[0]});
  return "ok";
}`;

    const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", jxaScript], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode === 0) return { ok: true };
    return { ok: false, error: stderr.trim() };
  } finally {
    await cleanupTmpFile(tmpFile);
  }
}

/**
 * Fallback: send using classic AppleScript.
 * Reads message from temp file. Tries participant syntax, then buddy syntax.
 */
async function sendViaAppleScript(contact: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const tmpFile = join(tmpdir(), `clawty-${Date.now()}.txt`);
  await Bun.write(tmpFile, text);

  const escapedContact = contact.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedPath = tmpFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  try {
    // Try participant syntax first (modern macOS)
    const script = `
set msgFile to POSIX file "${escapedPath}"
set msgContent to read msgFile as «class utf8»
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escapedContact}" of targetService
  send msgContent to targetBuddy
end tell`;

    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode === 0) return { ok: true };

    // Try buddy syntax (older macOS)
    const fallbackScript = `
set msgFile to POSIX file "${escapedPath}"
set msgContent to read msgFile as «class utf8»
tell application "Messages"
  send msgContent to buddy "${escapedContact}" of (service 1 whose service type is iMessage)
end tell`;

    const fallbackProc = Bun.spawn(["osascript", "-e", fallbackScript], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [fbExit, fbErr] = await Promise.all([
      fallbackProc.exited,
      new Response(fallbackProc.stderr).text(),
    ]);

    if (fbExit === 0) return { ok: true };
    return { ok: false, error: `participant: ${stderr.trim()} | buddy: ${fbErr.trim()}` };
  } finally {
    await cleanupTmpFile(tmpFile);
  }
}

/**
 * Send an iMessage to a contact. Tries JXA first, falls back to AppleScript.
 */
export async function sendIMessage(contact: string, message: string): Promise<void> {
  const chunks = splitMessage(message, MAX_IMESSAGE_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;

    // Try JXA first (chat-based, most reliable on modern macOS)
    let result = await sendViaJxa(contact, chunk);

    // Fall back to AppleScript if JXA fails
    if (!result.ok) {
      process.stderr.write(`JXA send failed (${result.error}), trying AppleScript fallback...\n`);
      result = await sendViaAppleScript(contact, chunk);
    }

    if (!result.ok) {
      throw new Error(
        `Failed to send iMessage: ${result.error}\n\n` +
        `Make sure:\n` +
        `1. Messages.app is open and signed in to iMessage\n` +
        `2. Your terminal has Automation permission for Messages\n` +
        `   (System Settings → Privacy & Security → Automation)\n` +
        `3. You have an existing chat with this contact in Messages`
      );
    }

    // Small delay between chunks to maintain order
    if (i < chunks.length - 1) {
      await Bun.sleep(500);
    }
  }
}

/**
 * Split a long message into chunks at natural breakpoints.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n${chunk}`);
  }

  return chunks;
}

/**
 * Test that we can reach Messages.app (permissions check).
 */
export async function verifySendPermission(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["osascript", "-e", 'tell application "Messages" to get name'], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
