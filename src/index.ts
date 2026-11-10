import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig, shouldAutoConnect } from "./config.js";
import { extractTextFromMessage, extractThinkingFromMessage, formatAskQuestions, formatThinking, formatToolCall, formatToolResult, hasToolCalls, splitMessage } from "./formatting.js";
import { answerHint, buildAskOutcome, parseAskAnswers, renderAskAnswersText } from "./ask.js";
import { formatContextUsage } from "./formatting.js";
import { chatCommand } from "./chat-commands.js";
import { createPendingMessages } from "./pending-messages.js";
import { logVerification } from "./transports/verification.js";
import type { AskRequest } from "./ask.js";
import { acquireLock, releaseLock } from "./lock.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import type { ExternalMessage, PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

/**
 * Custom message type pi-web uses to record answers to an ask_user question set.
 * Sending it from here makes the transcript (and the web UI reading it) agree
 * with a submission made in the browser form.
 */
const ASK_USER_ANSWERS_CUSTOM_TYPE = "pi-web.ask.answers";

/** The question set the chat may still answer, if one is outstanding. */
let pendingAsk: AskRequest | null = null;

/**
 * Command that performs the reload. pi cannot reload while the agent runs and a
 * chat message arrives outside any command handler, so the reload is dispatched
 * as a command: immediately when idle, from `agent_settled` when mid-turn.
 */
const RELOAD_COMMAND = "bridge-reload";

/** Set when a chat asked to reload during a turn. */
let reloadRequested = false;

/** Deferred `!compact`, run once the current turn settles. */
let compactRequestedFor: { chatId: string; transport: string } | null = null;

/** Chat messages that arrived while pi refused prompts (compaction in flight). */
const pendingChatMessages = createPendingMessages<ExternalMessage>();
let compactionInFlight = false;

/** Min interval between in-place edits of a live streamed message. */
const STREAM_EDIT_THROTTLE_MS = 900;

/** Tracks one edit-in-place streamed message (thinking or response) for a turn. */
interface StreamState {
  msgId: string | null;
  lastText: string;
  lastEditAt: number;
}

/**
 * pi-matrix-bridge extension
 * Bridges Matrix into pi.
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;

  // Live streaming state — thinking and the response each get one message that's
  // edited in place as tokens arrive, so the user can read along and steer/stop.
  const thinkingStream: StreamState = { msgId: null, lastText: "", lastEditAt: 0 };
  const responseStream: StreamState = { msgId: null, lastText: "", lastEditAt: 0 };
  let streamEditInFlight = false;
  let turnShowThinking = false;
  // The response message renders the streamed text plus per-tool blocks. Each
  // block shows the call the moment the tool starts running (some take seconds),
  // then gets its output appended when the tool finishes. Keyed by toolCallId so
  // parallel tools pair correctly.
  let streamedText = "";
  let toolEntries: { id: string; text: string }[] = [];
  let turnShowTools = false;

  /**
   * Update status widget
   */
  function updateWidget(): void {
    const config = loadConfig();

    if (config.showWidget === false) {
      ctx.ui.setWidget("matrix-bridge-status", undefined);
      return;
    }

    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("matrix-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("matrix-bridge-status", undefined);
    }
  }

  /**
   * Build the read-only summary shown by the `/session` admin command.
   * Everything here is on the base ExtensionContext (plus pi.getThinkingLevel).
   */
  function formatSessionInfo(): string {
    const sm = ctx.sessionManager;
    const usage = ctx.getContextUsage();

    const lines = [
      "━━━ Session ━━━",
      `Model: ${ctx.model?.name ?? "unknown"}`,
      `Thinking: ${pi.getThinkingLevel()}`,
    ];

    if (usage) {
      const tokens = usage.tokens != null ? usage.tokens.toLocaleString() : "?";
      const window = usage.contextWindow.toLocaleString();
      const pct = usage.percent != null ? ` (${usage.percent.toFixed(0)}%)` : "";
      lines.push(`Context: ${tokens} / ${window}${pct}`);
    }

    lines.push(`Entries: ${sm.getEntries().length}`);
    const name = sm.getSessionName();
    if (name) lines.push(`Name: ${name}`);
    lines.push(`Status: ${ctx.isIdle() ? "idle" : "working"}`);

    return lines.join("\n");
  }

  /**
   * /shutdown — the ack reply is already sent; gracefully stop pi. Under a
   * systemd unit with Restart=always this relaunches into a fresh session.
   */
  function handleShutdown(): void {
    ctx.shutdown();
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Send or edit-in-place a streamed message, throttling edits. The first push
   * sends immediately; later pushes for the same stream edit the same message.
   */
  async function pushStream(
    chat: PendingRemoteChat,
    state: StreamState,
    text: string,
    force = false
  ): Promise<void> {
    if (!text || text === state.lastText) return;
    const now = Date.now();
    if (!force && state.msgId && now - state.lastEditAt < STREAM_EDIT_THROTTLE_MS) return;

    if (!state.msgId) {
      state.msgId = await transportManager.sendMessage(chat.chatId, chat.transport, text);
    } else {
      await transportManager.editMessage(chat.chatId, chat.transport, state.msgId, text);
    }
    state.lastText = text;
    state.lastEditAt = now;
  }

  /**
   * Render the response message: the streamed text plus each tool's call line
   * (and its output once it finishes), in start order.
   */
  function renderResponse(): string {
    const parts: string[] = [];
    if (streamedText) parts.push(streamedText);
    if (toolEntries.length) parts.push(toolEntries.map((e) => e.text).join("\n"));
    return parts.join("\n\n");
  }

  /**
   * Push the current response render to its message. `force` bypasses the edit
   * throttle (used when a tool starts/finishes, so it appears immediately).
   */
  async function pushResponse(chat: PendingRemoteChat, force = false): Promise<void> {
    await pushStream(chat, responseStream, renderResponse(), force);
  }

  /**
   * Hand a chat message to the agent, queueing it while compaction runs.
   *
   * `prompt()` throws "Cannot submit a prompt while compaction is in progress"
   * before it considers `deliverAs`, so mid-compaction messages have to wait;
   * the rejection used to be unhandled and the message vanished.
   */
  function forwardToAgent(msg: ExternalMessage): void {
    if (compactionInFlight) {
      pendingChatMessages.push(msg);
      logVerification(`chat event queued (compaction in flight): queue=${pendingChatMessages.size()}`);
      transportManager
        .sendMessage(
          msg.chatId,
          msg.transport,
          `⏳ Compaction is running — queued (${pendingChatMessages.size()} waiting).`
        )
        .catch(() => {});
      return;
    }

    pendingRemoteChat = {
      chatId: msg.chatId,
      transport: msg.transport,
      username: msg.username,
      messageId: msg.messageId,
    };

    const taggedMessage = `[📱 @${msg.username} via ${msg.transport}]: ${msg.content}`;
    // Only queue as a follow-up when the agent is mid-turn — that's the case
    // `followUp` was added for (avoiding a crash on a message arriving during
    // a turn, fixes #10). When idle, send normally so the message triggers a
    // turn and renders immediately; otherwise the very first message can sit
    // in the queue without ever showing.
    //
    // `pi.sendUserMessage()` returns void, so a rejection inside pi cannot be
    // observed here — hence the guard above rather than a catch here.
    logVerification(`chat event -> agent: room=${msg.chatId} idle=${ctx.isIdle()}`);
    pi.sendUserMessage(taggedMessage, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  /**
   * Replay chat messages held back by a compaction.
   *
   * Only sends once the session is genuinely idle: `session_compact` is emitted
   * *before* pi clears its manual-compaction state, so a prompt from that
   * handler is still refused. Retries until the session settles instead of
   * dropping the queued messages.
   */
  function flushPendingChatMessages(attempt = 0): void {
    if (compactionInFlight || pendingChatMessages.size() === 0) return;
    if (!ctx.isIdle()) {
      if (attempt < 120) {
        setTimeout(() => flushPendingChatMessages(attempt + 1), 500);
      } else {
        logVerification(`chat queue STUCK: ${pendingChatMessages.size()} message(s) not delivered`);
      }
      return;
    }
    const queued = pendingChatMessages.drain();
    logVerification(`chat queue flushing: ${queued.length} message(s)`);
    for (const message of queued) {
      forwardToAgent(message);
    }
  }

  /**
   * Compact the context and report the result into the chat that asked for it.
   *
   * `ctx.compact()` is fire-and-forget with callbacks, so the outcome is only
   * known later — the chat gets a "compacting" line and then the result, which
   * matters because a compaction that silently fails would look like nothing
   * happened.
   */
  function runCompaction(chatId: string, transport: string): void {
    const before = ctx.getContextUsage();
    const reply = (text: string): void => {
      transportManager
        .sendMessage(chatId, transport, text)
        .catch((err) => ctx.ui.notify(`Failed to send compaction status: ${(err as Error).message}`, "warning"));
    };

    reply(`🗜️ Compacting${before ? ` (was ${formatContextUsage(before)})` : ""}…`);
    logVerification("chat command: compact");

    try {
      ctx.compact({
        onComplete: () => {
          const after = ctx.getContextUsage();
          reply(`✅ Context compacted${after ? ` — now ${formatContextUsage(after)}` : ""}.`);
          logVerification("chat command: compact done");
        },
        onError: (err: Error) => {
          reply(`❌ Compaction failed: ${err.message}`);
          logVerification(`chat command: compact FAILED: ${err.message}`);
        },
      });
    } catch (err) {
      reply(`❌ Compaction failed: ${(err as Error).message}`);
      logVerification(`chat command: compact FAILED: ${(err as Error).message}`);
    }
  }

  /**
   * Force the response message to re-render immediately, guarded against
   * overlapping edits. Used by tool start/end events. If a render is already in
   * flight the new state is still captured in toolEntries and shown by the next
   * render (or turn_end), so nothing is lost.
   */
  async function flushResponse(): Promise<void> {
    if (!pendingRemoteChat || streamEditInFlight) return;
    const chat = pendingRemoteChat;
    streamEditInFlight = true;
    try {
      await pushResponse(chat, true);
      transportManager.sendTyping(chat.chatId, chat.transport).catch(() => {});
    } catch (_err) {
      // best-effort
    } finally {
      streamEditInFlight = false;
    }
  }

  /**
   * Initialize extension
   */
  /**
   * Chat-driven reload. Registered as a command because that is the only place
   * `ctx.reload()` may be awaited; a chat message arrives from the Matrix sync
   * loop, where pi is not in a reloadable context.
   */
  pi.registerCommand(RELOAD_COMMAND, {
    description: "Reload extensions, skills, prompts and themes (used by the chat !reload)",
    handler: async (_args, commandContext) => {
      await commandContext.reload();
      return;
    },
  });

  pi.on("agent_settled", () => {
    if (compactRequestedFor) {
      const target = compactRequestedFor;
      compactRequestedFor = null;
      runCompaction(target.chatId, target.transport);
    }
    if (!reloadRequested) return;
    reloadRequested = false;
    // Dispatch as a command, not model input, so no turn is started for it.
    pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
  });

  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState,
      handleShutdown,
      formatSessionInfo,
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize the Matrix transport in the background (non-blocking)
    (async () => {
      if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
        const matrixProvider = new MatrixProvider(config.matrix, auth);
        matrixProvider.onVerificationNotification((message, level) => {
          ctx.ui.notify(message, level);
        });
        transportManager.addTransport(matrixProvider);
      }

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && shouldAutoConnect(config)) {
        if (!acquireLock()) {
          ctx.ui.notify("ℹ️ matrix-bridge: another instance is already connected — skipping auto-connect", "info");
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseLock();
            ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage(async (msg) => {
      // "stop" interrupts the current turn. Accept a bare word or a / or !
      // prefix ("stop", "/stop", "!stop"). It's a reserved word for any
      // authorized user (onMessage only fires post-auth) and is not forwarded
      // to the agent.
      const stripped = msg.content.trim().replace(/^[/!]/, "").toLowerCase();
      if (stripped === "stop") {
        if (!ctx.isIdle()) ctx.abort();
        // Clear the typing indicator left over from the interrupted turn so the
        // client stops showing the "thinking" animation immediately.
        transportManager.stopTyping(msg.chatId, msg.transport).catch(() => {});
        transportManager
          .sendMessage(msg.chatId, msg.transport, "⏹️ Stopped the current turn.")
          .catch((err) =>
            ctx.ui.notify(`Failed to send stop ack: ${(err as Error).message}`, "error")
          );
        return;
      }

      // Answers to an outstanding ask_user question set are delivered as the
      // same custom message the browser form produces, so the agent and the web
      // UI both see a submitted answer rather than stray chat text.
      if (pendingAsk) {
        const ask = pendingAsk;
        const skip = stripped === "skip";
        const answers = skip ? [] : parseAskAnswers(msg.content, ask);
        if (skip || answers) {
          const outcome = buildAskOutcome(
            ask,
            answers ?? [],
            new Date().toISOString(),
            skip ? "cancelled" : "submitted"
          );
          if (compactionInFlight) {
            // pi refuses prompts while compacting; keep the ask open so the
            // answers are not consumed and lost.
            await transportManager
              .sendMessage(msg.chatId, msg.transport, "⏳ Compaction is running — reopening answers afterwards.")
              .catch(() => {});
            return;
          }
          pendingAsk = null;
          pi.sendMessage(
            {
              customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
              content: renderAskAnswersText(outcome),
              display: true,
              details: outcome,
            },
            { triggerTurn: true, deliverAs: "followUp" }
          );
          transportManager
            .sendMessage(
              msg.chatId,
              msg.transport,
              `✅ ${skip ? "Skipped" : "Answers submitted"} (${outcome.answeredCount}/${outcome.questions.length} answered).`
            )
            .catch((err) =>
              ctx.ui.notify(`Failed to send answer ack: ${(err as Error).message}`, "error")
            );
          return;
        }
      }

      // `!reload` / `/reload` from the chat reloads pi (extensions, skills,
      // prompts). Acknowledge first: the reload tears this runtime down.
      const command = chatCommand(msg.content);

      if (command?.name === "compact") {
        if (ctx.isIdle()) {
          runCompaction(msg.chatId, msg.transport);
        } else {
          // Compacting mid-turn would race the running request; defer it.
          compactRequestedFor = { chatId: msg.chatId, transport: msg.transport };
          await transportManager
            .sendMessage(msg.chatId, msg.transport, "🗜️ Compacting once this turn finishes…")
            .catch(() => {});
        }
        return;
      }

      if (command?.name === "steer") {
        const instruction = command.arg.trim();
        if (!instruction) {
          await transportManager
            .sendMessage(msg.chatId, msg.transport, "Usage: `!steer <instruction for the running turn>`")
            .catch(() => {});
          return;
        }
        if (compactionInFlight) {
          pendingChatMessages.push({ ...msg, content: instruction });
          await transportManager
            .sendMessage(
              msg.chatId,
              msg.transport,
              `⏳ Compaction is running — queued as a normal message (${pendingChatMessages.size()} waiting).`
            )
            .catch(() => {});
          return;
        }
        if (ctx.isIdle()) {
          // Nothing to steer into; deliver it rather than swallow it.
          forwardToAgent({ ...msg, content: instruction });
          await transportManager
            .sendMessage(msg.chatId, msg.transport, "▶️ No turn running — sent as a normal message.")
            .catch(() => {});
          return;
        }
        pendingRemoteChat = {
          chatId: msg.chatId,
          transport: msg.transport,
          username: msg.username,
          messageId: msg.messageId,
        };
        logVerification("chat command: steer");
        pi.sendUserMessage(`[📱 @${msg.username} via ${msg.transport}]: ${instruction}`, {
          deliverAs: "steer",
        });
        await transportManager
          .sendMessage(msg.chatId, msg.transport, "🎯 Steered into the running turn.")
          .catch(() => {});
        return;
      }

      if (command?.name === "reload") {
        const idle = ctx.isIdle();
        logVerification(`chat command: ${RELOAD_COMMAND} (${idle ? "idle" : "mid-turn"})`);
        // Await the ack: reload tears the transport down, and an un-awaited send
        // is lost, leaving the room silent about a successful reload.
        try {
          await transportManager.sendMessage(
            msg.chatId,
            msg.transport,
            idle
              ? "🔄 Reloading the pi runtime…"
              : "🔄 Reloading once this turn finishes…"
          );
        } catch (err) {
          ctx.ui.notify(`Failed to send reload ack: ${(err as Error).message}`, "warning");
        }
        if (idle) {
          pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
        } else {
          // Mid-turn: the settled handler dispatches once the turn ends, so the
          // reload cannot interrupt running work.
          reloadRequested = true;
        }
        return;
      }

      forwardToAgent(msg);
    });

    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    updateWidget();
  });

  // pi refuses prompts while compacting, so track it and hold chat messages.
  pi.on("session_before_compact", () => {
    compactionInFlight = true;
  });

  const afterCompaction = (): void => {
    compactionInFlight = false;
    // One tick later: emission precedes pi clearing its compaction state.
    setTimeout(() => flushPendingChatMessages(), 0);
  };

  pi.on("session_compact", afterCompaction);
  pi.on("session_compact_failed", afterCompaction);

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (_event, _context) => {
    // Reset per-turn streaming state and cache the toggle for the hot path
    // (message_update fires per token — avoid a config file read each time).
    thinkingStream.msgId = null;
    thinkingStream.lastText = "";
    thinkingStream.lastEditAt = 0;
    responseStream.msgId = null;
    responseStream.lastText = "";
    responseStream.lastEditAt = 0;
    streamEditInFlight = false;
    streamedText = "";
    toolEntries = [];
    const cfg = loadConfig();
    turnShowThinking = cfg.hideThinking !== true;
    turnShowTools = cfg.hideToolCalls !== true;

    if (pendingRemoteChat) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport
        );
      } catch (_err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Stream live — edit a 💭 message as the reasoning grows and a separate
   * message as the response text grows, so the user can follow along and
   * steer/stop a wrong turn before it commits.
   */
  pi.on("message_update", async (event, _context) => {
    if (!pendingRemoteChat || streamEditInFlight) return;

    const message = event.message as AssistantMessage;
    if (!Array.isArray(message?.content)) return;

    const chat = pendingRemoteChat;
    streamEditInFlight = true;
    try {
      if (turnShowThinking) {
        const thinking = extractThinkingFromMessage(message);
        if (thinking) await pushStream(chat, thinkingStream, formatThinking(thinking));
      }

      streamedText = extractTextFromMessage(message).trim();
      await pushResponse(chat);

      // Keep the typing indicator alive alongside the streamed messages.
      if (thinkingStream.msgId || responseStream.msgId) {
        transportManager.sendTyping(chat.chatId, chat.transport).catch(() => {});
      }
    } catch (_err) {
      // Streaming is best-effort — ignore transient send/edit errors.
    } finally {
      streamEditInFlight = false;
    }
  });

  /**
   * Show each tool call the moment it starts running (some tools take seconds),
   * appended to the live response message.
   */
  pi.on("tool_execution_start", async (event, _context) => {
    if (!pendingRemoteChat || !turnShowTools) return;

    // Record first so it's never lost — turn_end renders from toolEntries even if
    // the live edit below is skipped (e.g. a render is mid-flight).
    toolEntries.push({ id: event.toolCallId, text: formatToolCall(event.toolName, event.args) });
    await flushResponse();
  });

  /**
   * Append each tool's output under its call line once it finishes.
   */
  pi.on("tool_execution_end", async (event, _context) => {
    if (!pendingRemoteChat || !turnShowTools) return;

    const entry = toolEntries.find((e) => e.id === event.toolCallId);
    if (!entry) return;
    const output = formatToolResult(event.result, event.isError);
    if (output) entry.text += `\n${output}`;
    await flushResponse();
  });

  /**
   * Mirror ask_user requests into the chat.
   *
   * ask_user posts an interactive form in pi-web, terminates the run, and
   * delivers the answers later as a follow-up message. From Matrix the room
   * would otherwise see only a tool-call line and could not answer at all, so
   * the questions are rendered here as lettered options. A plain reply in the
   * chat then reaches the agent as a normal message, which is exactly what the
   * follow-up would have looked like.
   */
  pi.on("tool_result", async (event, _context) => {
    if (event.toolName !== "ask_user" || event.isError) return;
    const ask = (event.details as { ask?: { questions?: unknown[] } } | undefined)?.ask;
    if (!ask?.questions?.length) return;

    // Remembered so a reply in the chat can be delivered as a real answer; the
    // question set itself is durable in the transcript, but only this process
    // can submit an outcome.
    pendingAsk = ask as unknown as AskRequest;

    const chat = pendingRemoteChat;
    if (!chat) return; // ask was not started from a chat turn

    try {
      await transportManager.sendMessage(
        chat.chatId,
        chat.transport,
        `${formatAskQuestions(ask as Parameters<typeof formatAskQuestions>[0])}\n\n${answerHint()}`
      );
    } catch (err) {
      ctx.ui.notify(`⚠️ Could not post questions to chat: ${(err as Error).message}`, "warning");
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat) return;
    const chat = pendingRemoteChat;

    try {
      const message = event.message as AssistantMessage;
      const hasPendingTools = hasToolCalls(message);
      const config = loadConfig();

      // Finalize the streamed thinking message — the last live edit may have
      // been throttled, so push the complete reasoning once the turn ends.
      if (!config.hideThinking && thinkingStream.msgId) {
        const finalThinking = formatThinking(extractThinkingFromMessage(message));
        if (finalThinking !== thinkingStream.lastText) {
          await transportManager
            .editMessage(chat.chatId, chat.transport, thinkingStream.msgId, finalThinking)
            .catch(() => {});
        }
      }

      // Final response = streamed text plus the per-tool blocks (call + output)
      // accumulated from the tool execution events this turn.
      streamedText = extractTextFromMessage(message).trim();
      const fullText = renderResponse();

      if (!fullText) {
        // Nothing to send this turn (e.g. pure thinking, or hidden tool calls);
        // keep pendingRemoteChat so a future turn's response routes correctly.
        return;
      }

      if (responseStream.msgId) {
        // Finalize the streamed response message in place.
        if (fullText !== responseStream.lastText) {
          await transportManager.editMessage(
            chat.chatId,
            chat.transport,
            responseStream.msgId,
            fullText
          );
        }
      } else {
        // Nothing was streamed (e.g. a tool-only turn) — send it now, chunked.
        for (const chunk of splitMessage(fullText, 4000)) {
          await transportManager.sendMessage(chat.chatId, chat.transport, chunk);
        }
      }

      if (!hasPendingTools) {
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      pendingRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release lock and disconnect transports
   */
  pi.on("session_shutdown", async (_event, _context) => {
    await transportManager.disconnectAll();
    releaseLock();
  });

  /**
   * /matrix-bridge command - show status or manage connections
   */
  pi.registerCommand("matrix-bridge", {
    description: "Manage the Matrix bridge (help|status|connect|disconnect|configure|verify|widget)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

    // No subcommand → open interactive menu
    if (!subcommand || subcommand === "menu") {
      await openMainMenu({
        ui: context.ui,
        transportManager,
        auth,
        updateWidget,
      });
      return;
    }

    switch (subcommand) {
      case "help": {
        const helpText = [
          "━━━ Matrix Bridge Commands ━━━",
          "",
          "/matrix-bridge                   Open interactive menu",
          "/matrix-bridge help              Show this help",
          "/matrix-bridge status            Show connection and user status",
          "/matrix-bridge connect           Connect to Matrix",
          "/matrix-bridge disconnect        Disconnect from Matrix",
          "/matrix-bridge configure matrix <homeserver-url> <access-token>",
          "                              Configure Matrix (Element X, etc)",
          "/matrix-bridge verify            List pending device verifications",
          "/matrix-bridge verify accept <id>  Confirm SAS emoji match (verifies device)",
          "/matrix-bridge verify mismatch <id>  Report SAS values did not match",
          "/matrix-bridge verify cancel <id>  Abort a verification",
          "/matrix-bridge verify start <device>  Start verification from the bridge",
          "/matrix-bridge verify auto on|off  Auto-confirm SAS (beats the 60s timeout)",
          "/matrix-bridge verify sign <device>  Cross-sign without SAS (needs recovery-key file)",
          "/matrix-bridge widget            Toggle status widget on/off",
          "/matrix-bridge toggletools       Toggle tool call visibility",
          "/matrix-bridge togglethinking    Toggle live thinking (💭) visibility",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      }
      case "connect":
        if (!acquireLock()) {
          context.ui.notify("⚠️ Another matrix-bridge instance is already connected. Run /matrix-bridge disconnect there first.", "warning");
          break;
        }
        try {
          await transportManager.connectAll();
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          releaseLock();
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;

      case "disconnect": {
        await transportManager.disconnectAll();
        releaseLock();
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;
      }

      case "configure": {
        const platform = parts[1];
        const token = parts.slice(2).join(" ");

        if (!platform) {
          context.ui.notify("Usage: /matrix-bridge configure <platform> [token/path]", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "matrix": {
            const matrixParts = token.split(/\s+/);
            const homeserverUrl = matrixParts[0];
            const matrixAccessToken = matrixParts.slice(1).join(" ");
            if (!homeserverUrl || !matrixAccessToken) {
              context.ui.notify("Usage: /matrix-bridge configure matrix <homeserver-url> <access-token>", "error");
              return;
            }

            config.matrix = { homeserverUrl, accessToken: matrixAccessToken };
            saveConfig(config);
            const matrixProvider = new MatrixProvider(config.matrix, auth);
            matrixProvider.onVerificationNotification((message, level) => {
              context.ui.notify(message, level);
            });
            transportManager.addTransport(matrixProvider);
            if (acquireLock()) {
              try {
                await matrixProvider.connect();
                context.ui.notify("✅ Matrix configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Matrix configured (another instance is connected — run /matrix-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;
      }

      case "verify": {
        const transport = transportManager.getTransport("matrix");
        if (!(transport instanceof MatrixProvider)) {
          context.ui.notify("❌ Matrix is not configured. Run /matrix-bridge configure matrix first.", "error");
          break;
        }
        if (!transport.isConnected) {
          context.ui.notify("⚠️ Matrix is not connected. Run /matrix-bridge connect first.", "warning");
          break;
        }
        if (!transport.encryptionEnabled) {
          context.ui.notify("⚠️ E2EE is disabled for this transport — device verification is unavailable.", "warning");
          break;
        }

        const action = parts[1] ?? "list";
        const id = parts.slice(2).join(" ").trim();
        try {
          switch (action) {
            case "list": {
              const pending = transport.listVerifications();
              if (pending.length === 0) {
                context.ui.notify(
                  [
                    "No device verification in progress.",
                    "Start one in Element: Settings → Sessions → select this session → Verify.",
                    `(bridge device: ${transport.deviceId ?? "unknown"})`,
                  ].join("\n"),
                  "info",
                );
              } else {
                const lines = ["━━━ Pending verifications ━━━"];
                for (const v of pending) {
                  lines.push(`${v.id}  ${v.userId} ${v.deviceId ?? ""}  [${v.phase}]`);
                  if (v.emoji?.length) lines.push(`  emoji: ${v.emoji.join(" ")}`);
                  if (v.decimal?.length) lines.push(`  numbers: ${v.decimal.join(" ")}`);
                }
                context.ui.notify(lines.join("\n"), "info");
              }
              break;
            }
            case "accept":
              if (!id) {
                context.ui.notify("Usage: /matrix-bridge verify accept <id>", "error");
                break;
              }
              await transport.acceptVerification(id);
              break;
            case "start":
              if (!id) {
                context.ui.notify("Usage: /matrix-bridge verify start <deviceId>", "error");
                break;
              }
              await transport.startVerification(id);
              break;
            case "auto": {
              const value = id.toLowerCase();
              if (value !== "on" && value !== "off") {
                context.ui.notify("Usage: /matrix-bridge verify auto on|off", "error");
                break;
              }
              transport.setVerificationAutoConfirm(value === "on");
              break;
            }
            case "sign":
              if (!id) {
                context.ui.notify("Usage: /matrix-bridge verify sign <deviceId>", "error");
                break;
              }
              await transport.crossSignDevice(id);
              break;
            case "mismatch":
              if (!id) {
                context.ui.notify("Usage: /matrix-bridge verify mismatch <id>", "error");
                break;
              }
              await transport.mismatchVerification(id);
              break;
            case "cancel":
              if (!id) {
                context.ui.notify("Usage: /matrix-bridge verify cancel <id>", "error");
                break;
              }
              await transport.cancelVerification(id);
              break;
            default:
              context.ui.notify(
                "Usage: /matrix-bridge verify [list|start <device>|auto on|off|sign <device>|accept <id>|mismatch <id>|cancel <id>]",
                "warning",
              );
          }
        } catch (err) {
          context.ui.notify(`❌ ${(err as Error).message}`, "error");
        }
        break;
      }

      case "widget": {
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;
      }

      case "status": {
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Matrix Bridge Status ━━━",
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];

        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }

        const matrixTransport = transportManager.getTransport("matrix");
        if (matrixTransport instanceof MatrixProvider && matrixTransport.isConnected) {
          lines.push("");
          lines.push(`Device: ${matrixTransport.deviceId ?? "unknown"}`);
          lines.push(`E2EE: ${matrixTransport.encryptionEnabled ? "on" : "off"}`);
        }

        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        context.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "toggletools": {
        const cfg3 = loadConfig();
        cfg3.hideToolCalls = !cfg3.hideToolCalls;
        saveConfig(cfg3);
        const toolState = cfg3.hideToolCalls ? "hidden" : "shown";
        context.ui.notify(`🔧 Tool calls ${toolState} in remote messages`, "info");
        break;
      }

      case "togglethinking": {
        const cfg4 = loadConfig();
        cfg4.hideThinking = !cfg4.hideThinking;
        saveConfig(cfg4);
        const thinkingState = cfg4.hideThinking ? "hidden" : "shown";
        context.ui.notify(`💭 Live thinking ${thinkingState} in remote messages`, "info");
        break;
      }
      default:
        context.ui.notify(`Unknown subcommand: ${subcommand}. Run /matrix-bridge help`, "warning");
        break;
    }
    },
  });
}
