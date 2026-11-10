import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractUsername,
  formatForMatrix,
  getRetryAfterMs,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
  parseVerifyCommand,
} from "./matrix-utils.js";

// ─── getRetryAfterMs ──────────────────────────────────────────

describe("getRetryAfterMs", () => {
  it("reads the typed retryAfterMs field", () => {
    expect(getRetryAfterMs({ statusCode: 429, retryAfterMs: 1856 })).toBe(1856);
  });

  it("falls back to the raw body.retry_after_ms", () => {
    expect(
      getRetryAfterMs({ statusCode: 429, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 2000 } })
    ).toBe(2000);
  });

  it("uses a default backoff for a 429 with no hint", () => {
    expect(getRetryAfterMs({ statusCode: 429 })).toBe(1000);
  });

  it("treats M_LIMIT_EXCEEDED as rate-limited even without a 429 status", () => {
    expect(getRetryAfterMs({ errcode: "M_LIMIT_EXCEEDED" })).toBe(1000);
  });

  it("returns null for a non-rate-limit error", () => {
    expect(getRetryAfterMs({ statusCode: 403, errcode: "M_FORBIDDEN" })).toBeNull();
  });

  it("returns null for a plain Error", () => {
    expect(getRetryAfterMs(new Error("boom"))).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(getRetryAfterMs(undefined)).toBeNull();
    expect(getRetryAfterMs(null)).toBeNull();
  });

  it("reads matrix-js-sdk's httpStatus and data.retry_after_ms", () => {
    expect(
      getRetryAfterMs({ httpStatus: 429, data: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 3000 } })
    ).toBe(3000);
  });

  it("recognises a matrix-js-sdk rate-limit error by errcode only", () => {
    expect(getRetryAfterMs({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED" })).toBe(1000);
  });
});

// ─── escapeHtml ───────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("handles all special chars together", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

// ─── formatForMatrix ──────────────────────────────────────────

describe("formatForMatrix", () => {
  it("returns plain body only for text without markdown", () => {
    const result = formatForMatrix("hello world");
    expect(result).toEqual({ body: "hello world" });
    expect(result.formattedBody).toBeUndefined();
  });

  it("converts **bold** to <strong>", () => {
    const result = formatForMatrix("this is **bold** text");
    expect(result.body).toBe("this is **bold** text");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
  });

  it("converts *italic* to <em>", () => {
    const result = formatForMatrix("this is *italic* text");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("does not confuse **bold** with *italic*", () => {
    const result = formatForMatrix("**bold** and *italic*");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("converts [text](url) to <a href>", () => {
    const result = formatForMatrix("click [here](https://example.com)");
    expect(result.formattedBody).toContain('<a href="https://example.com">here</a>');
  });

  it("converts newlines to <br>", () => {
    const result = formatForMatrix("line *one*\nline two");
    expect(result.formattedBody).toContain("<br>");
  });

  it("protects inline code from markdown conversion", () => {
    const result = formatForMatrix("use `**not bold**` here");
    expect(result.formattedBody).toContain("<code>");
    expect(result.formattedBody).not.toContain("<strong>not bold</strong>");
  });

  it("protects code blocks from markdown conversion", () => {
    const result = formatForMatrix("```\n**not bold**\n```");
    expect(result.formattedBody).toContain("<pre><code>");
    expect(result.formattedBody).not.toContain("<strong>");
  });

  it("adds language class to code blocks", () => {
    const result = formatForMatrix("```typescript\nconst x = 1;\n```");
    expect(result.formattedBody).toContain('class="language-typescript"');
  });

  it("escapes HTML inside code blocks", () => {
    const result = formatForMatrix("```\n<script>alert('xss')</script>\n```");
    expect(result.formattedBody).toContain("&lt;script&gt;");
    expect(result.formattedBody).not.toContain("<script>");
  });

  it("escapes HTML inside inline code", () => {
    const result = formatForMatrix("use `<div>` tag");
    expect(result.formattedBody).toContain("&lt;div&gt;");
  });

  it("preserves original text as body even when formatted", () => {
    const original = "**bold** and `code`";
    const result = formatForMatrix(original);
    expect(result.body).toBe(original);
  });

  it("escapes raw HTML in plain text instead of passing it through", () => {
    const result = formatForMatrix("a <b>bold</b> claim");
    expect(result.formattedBody).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(result.formattedBody).not.toContain("<b>");
  });

  it("renders an unterminated code fence (mid-stream) as a code block", () => {
    const result = formatForMatrix("```ts\nconst x = 1;");
    expect(result.formattedBody).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
    expect(result.formattedBody).not.toContain("```");
  });

  it("renders a still-open fence after normal text", () => {
    const result = formatForMatrix("here:\n```\nfoo()\nbar()");
    expect(result.formattedBody).toContain("<pre><code>foo()\nbar()</code></pre>");
  });

  it("keeps longer fences intact inside a code block", () => {
    const result = formatForMatrix("````md\n```ts\nx\n```\n````");
    expect(result.formattedBody).toContain("<pre><code class=\"language-md\">```ts\nx\n```</code></pre>");
  });

  it("converts ||spoiler|| to a Matrix spoiler span", () => {
    const result = formatForMatrix("careful: ||the butler did it||");
    expect(result.formattedBody).toContain("<span data-mx-spoiler>the butler did it</span>");
    expect(result.formattedBody).not.toContain("||");
  });

  it("keeps inline code inside a spoiler", () => {
    const result = formatForMatrix("||run `rm -rf /` first||");
    expect(result.formattedBody).toContain(
      "<span data-mx-spoiler>run <code>rm -rf /</code> first</span>"
    );
  });

  it("formats markdown and line breaks inside a spoiler", () => {
    const result = formatForMatrix("||**bold**\nnext||");
    expect(result.formattedBody).toContain("<span data-mx-spoiler><strong>bold</strong><br>next</span>");
  });

  it("passes /html messages through verbatim with a plain-text body", () => {
    const result = formatForMatrix("/html\n<p>Hello <b>there</b> &amp; welcome</p>");
    expect(result.formattedBody).toBe("<p>Hello <b>there</b> &amp; welcome</p>");
    expect(result.body).toBe("Hello there & welcome");
  });

  it("supports /html on a single line", () => {
    const result = formatForMatrix("/html <span data-mx-spoiler>secret</span>");
    expect(result.formattedBody).toBe('<span data-mx-spoiler>secret</span>');
    expect(result.body).toBe("secret");
  });

  it("ignores a bare /html with no content", () => {
    expect(formatForMatrix("/html")).toEqual({ body: "/html" });
  });

  it("renders a markdown prefix (rate-limit note) alongside /html", () => {
    const result = formatForMatrix("/html <b>hi</b>", "*(delayed)*");
    expect(result.body).toBe("*(delayed)*\n\nhi");
    expect(result.formattedBody).toBe("<em>(delayed)</em><br><br><b>hi</b>");
  });

  it("prepends a prefix to normal markdown messages", () => {
    const result = formatForMatrix("**hi**", "note");
    expect(result.body).toBe("note\n\n**hi**");
    expect(result.formattedBody).toBe("note<br><br><strong>hi</strong>");
  });
});

// ─── shouldSkipEvent ──────────────────────────────────────────

describe("shouldSkipEvent", () => {
  const botUserId = "@bot:matrix.org";
  const connectedAt = 1000;
  const joinedRooms = new Set(["!room1:matrix.org", "!room2:matrix.org"]);

  function makeEvent(overrides: Record<string, any> = {}) {
    return {
      sender: "@user:matrix.org",
      origin_server_ts: 2000,
      content: { msgtype: "m.text", body: "hello" },
      ...overrides,
    };
  }

  it("returns null for a valid message", () => {
    expect(shouldSkipEvent(makeEvent(), botUserId, connectedAt, joinedRooms, "!room1:matrix.org")).toBeNull();
  });

  it("skips own messages", () => {
    expect(shouldSkipEvent(makeEvent({ sender: botUserId }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("own_message");
  });

  it("skips stale events (before connectedAt)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 500 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });

  it("skips events at exactly connectedAt (boundary: < not <=)", () => {
    // connectedAt=1000, event ts=1000 → NOT stale (< is strict)
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 1000 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBeNull();
  });

  it("skips events with ts=999 (one below connectedAt)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 999 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });

  it("skips non-text messages", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.image", body: "photo" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips messages with no content", () => {
    expect(shouldSkipEvent(makeEvent({ content: undefined }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips messages with no body", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.text" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips edits (m.new_content present)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.text", body: "edited", "m.new_content": { body: "new" } } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBe("edit");
  });

  it("skips events from rooms not in joinedRooms", () => {
    expect(shouldSkipEvent(makeEvent(), botUserId, connectedAt, joinedRooms, "!unknown:matrix.org"))
      .toBe("not_joined");
  });

  it("handles missing origin_server_ts (defaults to 0, always stale)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: undefined }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });
});

// ─── extractUsername ──────────────────────────────────────────

describe("extractUsername", () => {
  it("extracts localpart from full MXID", () => {
    expect(extractUsername("@alice:matrix.org")).toBe("alice");
  });

  it("handles homeserver with port", () => {
    expect(extractUsername("@bob:localhost:8448")).toBe("bob");
  });

  it("handles already plain username", () => {
    expect(extractUsername("charlie")).toBe("charlie");
  });

  it("handles MXID without @ prefix", () => {
    expect(extractUsername("dave:matrix.org")).toBe("dave");
  });
});

// ─── wasBotMentioned ─────────────────────────────────────────

describe("wasBotMentioned", () => {
  const botUserId = "@pibot:matrix.org";

  it("detects full MXID mention", () => {
    expect(wasBotMentioned("hey @pibot:matrix.org do this", botUserId)).toBe(true);
  });

  it("detects @localpart mention (case-insensitive)", () => {
    expect(wasBotMentioned("hey @Pibot do this", botUserId)).toBe(true);
  });

  it("detects lowercase @localpart", () => {
    expect(wasBotMentioned("@pibot help", botUserId)).toBe(true);
  });

  it("returns false when not mentioned", () => {
    expect(wasBotMentioned("hello world", botUserId)).toBe(false);
  });

  it("returns false for bare localpart without @ (avoids false positives on names)", () => {
    // "pibot" appearing in casual chat without @ shouldn't be a mention
    expect(wasBotMentioned("pibot help", botUserId)).toBe(false);
  });

  it("returns false for partial match that isn't the localpart", () => {
    expect(wasBotMentioned("pi is great", botUserId)).toBe(false);
  });
});

// ─── stripBotMention ─────────────────────────────────────────

describe("stripBotMention", () => {
  const botUserId = "@pibot:matrix.org";

  it("strips full MXID mention", () => {
    expect(stripBotMention("@pibot:matrix.org help me", botUserId)).toBe("help me");
  });

  it("strips multiple mentions", () => {
    expect(stripBotMention("@pibot:matrix.org hey @pibot:matrix.org", botUserId)).toBe("hey");
  });

  it("returns original text when no mention present", () => {
    expect(stripBotMention("hello world", botUserId)).toBe("hello world");
  });

  it("handles mention at end of message", () => {
    expect(stripBotMention("help @pibot:matrix.org", botUserId)).toBe("help");
  });

  it("handles message that is only the mention", () => {
    expect(stripBotMention("@pibot:matrix.org", botUserId)).toBe("");
  });
});

// ─── Property tests ───────────────────────────────────────────

describe("formatForMatrix properties", () => {
  it("body always equals original input (preservation)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = formatForMatrix(text);
        expect(result.body).toBe(text);
      })
    );
  });

  it("formattedBody is undefined when no markdown chars present", () => {
    // Generate strings that don't contain markdown-triggering chars
    const noMarkdown = fc.string().filter((s) => !/[*_`#\[\]<>]|\|\|/.test(s));
    fc.assert(
      fc.property(noMarkdown, (text) => {
        const result = formatForMatrix(text);
        expect(result.formattedBody).toBeUndefined();
      })
    );
  });
});

describe("stripBotMention properties", () => {
  it("result never contains the bot MXID (verification)", () => {
    // Generate valid-ish MXIDs: @localpart:server
    const localpart = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/[@: ]/.test(s) && s.length > 0);
    const server = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/[@: ]/.test(s) && s.length > 0);
    const mxid = fc.tuple(localpart, server).map(([user, host]) => `@${user}:${host}`);

    fc.assert(
      fc.property(mxid, fc.string(), (botId, prefix) => {
        const text = `${prefix} ${botId} some text`;
        const result = stripBotMention(text, botId);
        expect(result).not.toContain(botId);
      })
    );
  });
});

describe("escapeHtml properties", () => {
  it("output never contains raw <, >, &, or \" (except as entities)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = escapeHtml(text);
        // After escaping, the only < > & " should be inside entity sequences
        const withoutEntities = result
          .replace(/&amp;/g, "")
          .replace(/&lt;/g, "")
          .replace(/&gt;/g, "")
          .replace(/&quot;/g, "");
        expect(withoutEntities).not.toMatch(/[<>"&]/);
      })
    );
  });
});

// Excluded from testing (design decisions / integration-only, verified by inspection):
// - connect()/disconnect() lifecycle (requires real MatrixClient)
// - sendMessage()/sendTyping() (thin SDK wrappers)
// - index.ts wiring (env var reading, command handler plumbing)
// - Widget abbreviation (mx)

describe("parseVerifyCommand", () => {
  it("treats a bare /verify as list", () => {
    expect(parseVerifyCommand("/verify")).toEqual({ action: "list" });
    expect(parseVerifyCommand("  /verify  ")).toEqual({ action: "list" });
  });

  it("parses the SAS actions with an id", () => {
    expect(parseVerifyCommand("/verify accept afd510066368414e9096bfc7a108d567")).toEqual({
      action: "accept",
      id: "afd510066368414e9096bfc7a108d567",
    });
    expect(parseVerifyCommand("/verify mismatch abc")).toEqual({ action: "mismatch", id: "abc" });
    expect(parseVerifyCommand("/verify cancel abc")).toEqual({ action: "cancel", id: "abc" });
    expect(parseVerifyCommand("/verify LIST")).toEqual({ action: "list" });
  });

  it("keeps ids that contain spaces", () => {
    expect(parseVerifyCommand("/verify accept @u:x: DEV")).toEqual({ action: "accept", id: "@u:x: DEV" });
  });

  it("ignores non-verification or unknown input", () => {
    expect(parseVerifyCommand("/verifyfoo")).toBeNull();
    expect(parseVerifyCommand("/verify nope abc")).toBeNull();
    expect(parseVerifyCommand("verify accept abc")).toBeNull();
    expect(parseVerifyCommand("hello")).toBeNull();
  });
});

describe("parseVerifyCommand start", () => {
  it("parses an explicit device id", () => {
    expect(parseVerifyCommand("/verify start daZejMzfih")).toEqual({ action: "start", id: "daZejMzfih" });
  });
});

describe("parseVerifyCommand sign", () => {
  it("parses the direct cross-sign action", () => {
    expect(parseVerifyCommand("/verify sign CONTOXFROGBOT")).toEqual({ action: "sign", id: "CONTOXFROGBOT" });
  });
});

describe("parseVerifyCommand auto", () => {
  it("parses the auto-confirm toggle", () => {
    expect(parseVerifyCommand("/verify auto on")).toEqual({ action: "auto", id: "on" });
    expect(parseVerifyCommand("/verify auto off")).toEqual({ action: "auto", id: "off" });
  });
});
