import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import type { IMessage } from "./types.ts";

const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200;

// On modern macOS, date is in nanoseconds since 2001-01-01
function appleTimestampToDate(timestamp: number): Date {
  // Handle both seconds and nanosecond formats
  // Nanosecond timestamps are > 1e15, second timestamps are < 1e12
  const seconds = timestamp > 1e15 ? timestamp / 1e9 : timestamp;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

// Extract text from attributedBody (NSAttributedString binary plist)
// On newer macOS, `text` column can be NULL and content is in attributedBody
function extractTextFromAttributedBody(buf: Buffer | Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    // The attributedBody is a binary plist containing NSAttributedString
    // The plain text is embedded as a UTF-8 string after a specific marker
    // Look for the streamtyped marker pattern and extract text after it
    const bytes = Buffer.from(buf);
    const str = bytes.toString("latin1");

    // Strategy 1: Look for NSString content between known markers
    // The text typically appears after "NSString" and before "NSDictionary"
    const nsStringIdx = str.indexOf("NSString");
    if (nsStringIdx !== -1) {
      // Find the start of actual text content
      // It's usually preceded by a length byte
      let searchStart = nsStringIdx + 8;
      // Skip past class info bytes to find the actual text
      for (let i = searchStart; i < Math.min(searchStart + 50, bytes.length); i++) {
        // Look for printable ASCII start after some binary bytes
        if (bytes[i]! >= 0x20 && bytes[i]! < 0x7f) {
          // Found potential text start, now find the end
          let textEnd = i;
          while (textEnd < bytes.length) {
            const b = bytes[textEnd]!;
            // Allow printable ASCII, common UTF-8 continuation bytes, and some control chars
            if (b >= 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x80 && b <= 0xfe)) {
              textEnd++;
            } else {
              break;
            }
          }
          if (textEnd - i > 1) {
            const extracted = bytes.subarray(i, textEnd).toString("utf-8").trim();
            if (extracted.length > 0) return extracted;
          }
        }
      }
    }

    // Strategy 2: Find text using the bplist pattern
    // Look for the content between specific byte patterns
    const markers = [
      Buffer.from([0x01, 0x94, 0x84, 0x01]), // Common marker before text
      Buffer.from([0x01, 0x84, 0x01]),          // Alternative marker
    ];

    for (const marker of markers) {
      const idx = bytes.indexOf(marker);
      if (idx !== -1) {
        const textStart = idx + marker.length;
        // Read until we hit a non-text byte sequence
        let textEnd = textStart;
        while (textEnd < bytes.length && bytes[textEnd] !== 0x06 && bytes[textEnd] !== 0x86) {
          textEnd++;
        }
        const extracted = bytes.subarray(textStart, textEnd).toString("utf-8").trim();
        if (extracted.length > 0) return extracted;
      }
    }

    // Strategy 3: Brute force - find the longest printable UTF-8 run
    let bestStart = 0;
    let bestLen = 0;
    let currentStart = 0;
    let currentLen = 0;

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b >= 0x20 || b === 0x0a || b === 0x0d || b === 0x09) {
        if (currentLen === 0) currentStart = i;
        currentLen++;
      } else if (b >= 0xc0 && b <= 0xfe) {
        // UTF-8 multibyte start
        if (currentLen === 0) currentStart = i;
        currentLen++;
      } else if (b >= 0x80 && b <= 0xbf && currentLen > 0) {
        // UTF-8 continuation byte
        currentLen++;
      } else {
        if (currentLen > bestLen) {
          bestStart = currentStart;
          bestLen = currentLen;
        }
        currentLen = 0;
      }
    }
    if (currentLen > bestLen) {
      bestStart = currentStart;
      bestLen = currentLen;
    }

    if (bestLen > 1) {
      return bytes.subarray(bestStart, bestStart + bestLen).toString("utf-8").trim();
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate common phone number variations for matching.
 * E.g. "6692333038" → ["+16692333038", "+1 6692333038", ...]
 *      "+16692333038" → ["16692333038", "6692333038", ...]
 */
function phoneVariations(contact: string): string[] {
  // Only generate variations for phone-number-like strings (digits, +, spaces, dashes)
  const digits = contact.replace(/[\s\-\(\)\.]/g, "");
  if (!/^\+?\d{7,15}$/.test(digits)) return [];

  const raw = digits.replace(/^\+/, "");
  const variations: string[] = [];

  if (raw.length === 10) {
    // Looks like a US number without country code: add +1
    variations.push(`+1${raw}`, `1${raw}`);
  } else if (raw.length === 11 && raw.startsWith("1")) {
    // Looks like a US number with country code 1: try with +, without 1
    variations.push(`+${raw}`, raw.slice(1), `+${raw.slice(1)}`);
  } else {
    // International: try with/without +
    if (digits.startsWith("+")) {
      variations.push(raw);
    } else {
      variations.push(`+${raw}`);
    }
  }

  return variations;
}

export class IMessageDatabase {
  private db: Database;
  private lastRowId: number = 0;
  private processedRowIds = new Set<number>();

  constructor() {
    if (!existsSync(CHAT_DB_PATH)) {
      throw new Error(
        `iMessage database not found at ${CHAT_DB_PATH}.\n` +
        `Make sure you're running on macOS with Messages.app configured.`
      );
    }

    try {
      // Open read-only; the DB already uses WAL mode (set by Messages.app)
      this.db = new Database(CHAT_DB_PATH, { readonly: true });
      // Wait up to 3s if Messages.app has the DB locked during WAL checkpoint
      this.db.exec("PRAGMA busy_timeout = 3000");
    } catch (e: any) {
      if (e.message?.includes("unable to open") || e.message?.includes("authorization denied")) {
        throw new Error(
          `Cannot access iMessage database. Full Disk Access is required.\n\n` +
          `To grant access:\n` +
          `1. Open System Settings → Privacy & Security → Full Disk Access\n` +
          `2. Click the + button\n` +
          `3. Add your terminal app (Terminal.app, iTerm2, Warp, etc.)\n` +
          `4. Restart your terminal and try again`
        );
      }
      throw e;
    }
  }

  initialize(): void {
    // Get the current max ROWID so we only process new messages
    const row = this.db.query("SELECT MAX(ROWID) as maxId FROM message").get() as { maxId: number } | null;
    this.lastRowId = row?.maxId ?? 0;
    // Initialized — only process new messages from here
  }

  getNewMessages(contact: string): IMessage[] {
    // Match contact by exact ID or by trailing digits (so "6692333038" matches "+16692333038")
    const contactDigits = contact.replace(/[^\d]/g, "");
    const isPhone = contactDigits.length >= 7;

    const query = this.db.query(`
      SELECT
        m.ROWID as rowId,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me as isFromMe,
        h.id as sender,
        h.service,
        c.chat_identifier as chatId
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE m.ROWID > ?1
        AND m.is_from_me = 0
        AND (h.id = ?2 OR (?3 AND REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), ' ', '') LIKE '%' || ?4))
        AND m.cache_roomnames IS NULL
      ORDER BY m.ROWID ASC
    `);

    const rows = query.all(this.lastRowId, contact, isPhone ? 1 : 0, contactDigits) as Array<{
      rowId: number;
      text: string | null;
      attributedBody: Buffer | null;
      date: number;
      isFromMe: number;
      sender: string;
      service: string;
      chatId: string | null;
    }>;

    const messages: IMessage[] = [];

    for (const row of rows) {
      // Skip already-processed ROWIDs (prevents self-message echo loops)
      if (this.processedRowIds.has(row.rowId)) continue;

      // Update last seen ROWID
      if (row.rowId > this.lastRowId) {
        this.lastRowId = row.rowId;
      }

      // Try to get text from the text column first, then attributedBody
      let text = row.text;
      if (!text && row.attributedBody) {
        text = extractTextFromAttributedBody(row.attributedBody);
      }

      // Skip messages with no extractable text
      if (!text || text.trim().length === 0) continue;

      this.processedRowIds.add(row.rowId);

      messages.push({
        rowId: row.rowId,
        text: text.trim(),
        sender: row.sender,
        date: appleTimestampToDate(row.date),
        isFromMe: row.isFromMe === 1,
        service: row.service ?? "iMessage",
        chatId: row.chatId,
      });
    }

    // Prune old processed ROWIDs to prevent memory leak (keep last 1000)
    if (this.processedRowIds.size > 1000) {
      const sorted = [...this.processedRowIds].sort((a, b) => a - b);
      const toRemove = sorted.slice(0, sorted.length - 500);
      for (const id of toRemove) this.processedRowIds.delete(id);
    }

    return messages;
  }

  /**
   * Get the N most recent messages for a contact (both incoming and outgoing).
   */
  getRecentMessages(contact: string, limit: number = 20): IMessage[] {
    const contactDigits = contact.replace(/[^\d]/g, "");
    const isPhone = contactDigits.length >= 7;

    const query = this.db.query(`
      SELECT
        m.ROWID as rowId,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me as isFromMe,
        COALESCE(h.id, ?1) as sender,
        COALESCE(h.service, 'iMessage') as service,
        c.chat_identifier as chatId
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE (
        (m.is_from_me = 0 AND (h.id = ?1 OR (?3 AND REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), ' ', '') LIKE '%' || ?4)))
        OR (m.is_from_me = 1 AND (c.chat_identifier LIKE '%' || ?1 || '%' OR (?3 AND c.chat_identifier LIKE '%' || ?4 || '%')))
      )
        AND m.cache_roomnames IS NULL
      ORDER BY m.ROWID DESC
      LIMIT ?2
    `);

    const rows = query.all(contact, limit, isPhone ? 1 : 0, contactDigits) as Array<{
      rowId: number;
      text: string | null;
      attributedBody: Buffer | null;
      date: number;
      isFromMe: number;
      sender: string;
      service: string;
      chatId: string | null;
    }>;

    const messages: IMessage[] = [];

    for (const row of rows) {
      let text = row.text;
      if (!text && row.attributedBody) {
        text = extractTextFromAttributedBody(row.attributedBody);
      }
      if (!text || text.trim().length === 0) continue;

      messages.push({
        rowId: row.rowId,
        text: text.trim(),
        sender: row.isFromMe === 1 ? "me" : row.sender,
        date: appleTimestampToDate(row.date),
        isFromMe: row.isFromMe === 1,
        service: row.service ?? "iMessage",
        chatId: row.chatId,
      });
    }

    // Reverse so oldest is first
    return messages.reverse();
  }

  /**
   * Get the current max ROWID.
   */
  getMaxRowId(): number {
    const row = this.db.query("SELECT MAX(ROWID) as maxId FROM message").get() as { maxId: number } | null;
    return row?.maxId ?? 0;
  }

  /**
   * Check if we can access the database (permissions check)
   */
  verify(): boolean {
    try {
      this.db.query("SELECT COUNT(*) FROM message").get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Look up a contact handle to verify it exists.
   * Tries the exact value first, then common phone number variations
   * (+1 prefix, stripped +1, etc.) so users don't have to get the format exactly right.
   */
  findContact(contact: string): { id: string; service: string } | null {
    // Try exact match first
    const exact = this.db.query(
      "SELECT id, service FROM handle WHERE id = ? LIMIT 1"
    ).get(contact) as { id: string; service: string } | null;
    if (exact) return exact;

    // Generate phone number variations to try
    const variations = phoneVariations(contact);
    for (const variant of variations) {
      const row = this.db.query(
        "SELECT id, service FROM handle WHERE id = ? LIMIT 1"
      ).get(variant) as { id: string; service: string } | null;
      if (row) return row;
    }

    return null;
  }

  /**
   * Advance the cursor past any new rows (e.g. after sending an outgoing message).
   * Prevents echo loops when bridging with your own number.
   */
  advanceCursor(): void {
    const row = this.db.query("SELECT MAX(ROWID) as maxId FROM message").get() as { maxId: number } | null;
    if (row?.maxId && row.maxId > this.lastRowId) {
      this.lastRowId = row.maxId;
    }
  }

  /**
   * Advance cursor aggressively to catch echo rows from self-messaging.
   * Polls multiple times over ~1.5s to catch the is_from_me=0 echo copy
   * that iMessage creates when you message yourself.
   */
  async advanceCursorWithDelay(): Promise<void> {
    this.advanceCursor();
    // Also mark all recent is_from_me=0 rows as processed to catch echoes
    this.markRecentAsProcessed();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 500));
      this.advanceCursor();
      this.markRecentAsProcessed();
    }
  }

  /**
   * Mark recent outgoing rows (is_from_me=1) as processed to prevent echo loops.
   * Only marks our own messages — never incoming messages from the contact.
   */
  private markRecentAsProcessed(): void {
    const rows = this.db.query(
      "SELECT ROWID FROM message WHERE ROWID > ?1 AND is_from_me = 1 ORDER BY ROWID ASC LIMIT 50"
    ).all(this.lastRowId - 5) as Array<{ ROWID: number }>;
    for (const row of rows) {
      this.processedRowIds.add(row.ROWID);
      if (row.ROWID > this.lastRowId) {
        this.lastRowId = row.ROWID;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
