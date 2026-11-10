/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability — no SDK or network dependencies.
 */

/** Small note prepended to the first message delivered after a rate-limit backoff. */
export const RATE_LIMIT_NOTE = "⏳ *(delayed — rate limited)*";

/** Default backoff when the server returns a 429 without a retry_after hint. */
const DEFAULT_RETRY_AFTER_MS = 1000;

/**
 * Extract the rate-limit backoff (in ms) from a thrown Matrix error.
 *
 * Returns the time to wait before retrying if the error is a rate-limit (429 /
 * M_LIMIT_EXCEEDED, or any error carrying a retry_after hint), otherwise null.
 * Reads defensively from the typed `retryAfterMs` field, matrix-js-sdk's
 * `httpStatus`/`data.retry_after_ms`, and the raw `body` shape, since any of
 * them may be present depending on the call path and SDK version.
 */
export function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    httpStatus?: number;
    statusCode?: number;
    errcode?: string;
    retryAfterMs?: number;
    data?: { errcode?: string; retry_after_ms?: number };
    body?: { errcode?: string; retry_after_ms?: number };
  };

  const hint = e.retryAfterMs ?? e.data?.retry_after_ms ?? e.body?.retry_after_ms;
  const errcode = e.errcode ?? e.data?.errcode ?? e.body?.errcode;
  const status = e.httpStatus ?? e.statusCode;
  const isRateLimited =
    status === 429 ||
    errcode === "M_LIMIT_EXCEEDED" ||
    typeof hint === "number";

  if (!isRateLimited) return null;
  return typeof hint === "number" && hint > 0 ? hint : DEFAULT_RETRY_AFTER_MS;
}

/** Escape HTML special characters */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A `/html` directive on the first line opts out of markdown conversion. */
const HTML_DIRECTIVE_RE = /^[ \t]*\/html(?:[ \t]+|\r?\n|$)/;

/** Sentinel marker for stashed, already-rendered HTML fragments. */
const STASH = "\u0000";

/** Characters that mean the text needs markdown → HTML conversion at all. */
const MARKDOWN_HINT = /[*_`#[\]<>]|\|\|/;

/**
 * Convert markdown to Matrix HTML. Returns the plain `body` plus an optional
 * `formatted_body` (Matrix's `org.matrix.custom.html`).
 *
 * Supported: fenced code blocks (3+ backticks, closed **or still open** so a
 * block being streamed renders as code), inline code, bold, italic, links, and
 * `||spoiler||` → `<span data-mx-spoiler>` (Matrix's native spoiler). Plain text
 * is HTML-escaped, so literal `<tag>` stays visible; a first-line `/html`
 * directive is the opt-out escape hatch and is passed through as raw HTML.
 */
export function formatForMatrix(
  text: string,
  prefix?: string
): { body: string; formattedBody?: string } {
  const directive = text.match(HTML_DIRECTIVE_RE);
  if (directive) {
    const html = text.slice(directive[0].length).trim();
    if (!html) return { body: prefix ? `${prefix}\n\n${text}` : text };
    const prefixBody = prefix ? `${htmlToPlainText(prefix)}\n\n` : "";
    // The prefix is markdown (rendered inline), the message body is raw HTML.
    const prefixHtml = prefix ? `${renderInline(escapeHtml(prefix))}<br><br>` : "";
    return {
      body: `${prefixBody}${htmlToPlainText(html)}`,
      formattedBody: `${prefixHtml}${html}`,
    };
  }

  const full = prefix ? `${prefix}\n\n${text}` : text;
  if (!MARKDOWN_HINT.test(full)) {
    return { body: full };
  }

  return { body: full, formattedBody: markdownToHtml(full) };
}

/**
 * Render markdown into the HTML subset Matrix clients understand.
 *
 * Escaping happens up front, before any markup is inserted, so raw HTML in the
 * source is shown literally (use the `/html` directive for real HTML). Already
 * rendered fragments (code, spoilers) are stashed behind sentinels so later
 * passes can't rewrite them.
 */
function markdownToHtml(text: string): string {
  const stash: string[] = [];
  const put = (html: string): string => `${STASH}${stash.push(html) - 1}${STASH}`;

  let out = escapeHtml(text.replace(/\r\n?/g, "\n"));

  // Fenced code blocks. The closing fence is optional: an unterminated block
  // (as seen mid-stream) renders as code up to the end of the message instead
  // of a wall of literal backticks that flips to a block once it finally closes.
  out = out.replace(
    /^[ \t]*(`{3,})([^\n`]*)\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm,
    (_match, _fence: string, info: string, code: string) => {
      const language = info.trim().split(/\s+/)[0] ?? "";
      const cls = language ? ` class="language-${language}"` : "";
      return put(`<pre><code${cls}>${code.replace(/\n$/, "")}</code></pre>`);
    }
  );

  // Inline code.
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => put(`<code>${code}</code>`));

  // Spoilers — rendered before the inline passes so their content can still
  // contain code/inline markup (already stashed) without closing early.
  out = out.replace(/\|\|([\s\S]+?)\|\|/g, (_match, body: string) =>
    put(`<span data-mx-spoiler>${renderInline(body)}</span>`)
  );

  out = renderInline(out);

  // Restore until stable: stashed fragments may themselves contain stashed
  // fragments (e.g. inline code inside a spoiler), which one pass would leave
  // as literal sentinels.
  let html = out;
  while (html.includes(STASH)) {
    const next = html.replace(/\u0000(\d+)\u0000/g, (_match, idx: string) => stash[Number(idx)] ?? "");
    if (next === html) break;
    html = next;
  }
  return html;
}

/** Apply the inline markdown rules (bold, italic, links, line breaks). */
function renderInline(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]\n]+?)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, "<br>");
}

/** Tag-stripped, entity-decoded fallback for raw HTML sent with `/html`. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Determine whether to skip a Matrix room event before processing.
 * Returns a reason string if the event should be skipped, or null if it should be processed.
 */
export function shouldSkipEvent(
  event: { sender?: string; origin_server_ts?: number; content?: any },
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string
): string | null {
  // Ignore own messages
  if (event.sender === botUserId) return "own_message";

  // Skip events from before this connection (stale replay from initial sync)
  const eventTs = event.origin_server_ts || 0;
  if (eventTs < connectedAt) return "stale";

  // Only process text messages
  const content = event.content;
  if (!content || content.msgtype !== "m.text" || !content.body) return "not_text";

  // Ignore edits (we only process original messages)
  if (content["m.new_content"]) return "edit";

  // Skip events from rooms we're not in (cached, no API call)
  if (!joinedRooms.has(roomId)) return "not_joined";

  return null;
}

/** Extract Matrix username (localpart) from a full MXID like @user:matrix.org */
export function extractUsername(userId: string): string {
  return userId.replace(/^@/, "").replace(/:.*$/, "");
}

/**
 * Check if bot was mentioned, matching either:
 *  - the full MXID `@user:server`
 *  - `@localpart` as a leading-@ word (avoids false-positives on bare names)
 */
export function wasBotMentioned(messageText: string, botUserId: string): boolean {
  if (messageText.includes(botUserId)) return true;
  const localpart = extractUsername(botUserId);
  if (!localpart) return false;
  const re = new RegExp(`@${escapeRegExp(localpart)}\\b`, "i");
  return re.test(messageText);
}

/** Strip bot mention from message text — symmetric with wasBotMentioned */
export function stripBotMention(text: string, botUserId: string): string {
  const localpart = extractUsername(botUserId);
  let out = text.replace(new RegExp(escapeRegExp(botUserId), "g"), "");
  if (localpart) {
    out = out.replace(new RegExp(`@${escapeRegExp(localpart)}\\b`, "gi"), "");
  }
  return out.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chat-side device-verification control. */
export type VerifyCommandAction = "list" | "start" | "sign" | "auto" | "accept" | "mismatch" | "cancel";

export interface VerifyCommand {
  action: VerifyCommandAction;
  /** Handle for accept/mismatch/cancel; absent for list. */
  id?: string;
}

/**
 * Parse a verification command typed in the chat, so the SAS emoji can be
 * compared and confirmed without a local TUI.
 *
 * Accepted shapes (case-insensitive verb):
 *   /verify
 *   /verify list
 *   /verify start <deviceId>   (bridge initiates; accept in Element)
 *   /verify sign <deviceId>    (cross-sign directly; needs recovery key file)
 *   /verify auto on|off        (confirm SAS automatically; beats the 60s timeout)
 *   /verify accept <id>
 *   /verify mismatch <id>
 *   /verify cancel <id>
 *
 * Returns null for anything else, so unknown `/…` input still reaches the agent.
 */
export function parseVerifyCommand(text: string): VerifyCommand | null {
  const match = /^\/verify(?:\s+(?<rest>.*))?$/is.exec(text.trim());
  if (!match) return null;

  const rest = (match.groups?.rest ?? "").trim();
  if (!rest) return { action: "list" };

  const [verb, ...tail] = rest.split(/\s+/);
  const action = verb.toLowerCase();
  if (
    action !== "list" &&
    action !== "start" &&
    action !== "sign" &&
    action !== "auto" &&
    action !== "accept" &&
    action !== "mismatch" &&
    action !== "cancel"
  ) {
    return null;
  }

  const id = tail.join(" ").trim();
  return id ? { action, id } : { action };
}
