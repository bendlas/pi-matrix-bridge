import {
  ClientEvent,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  MemoryStore,
  type Room,
  RoomEvent,
} from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";
import type { Logger } from "matrix-js-sdk/lib/logger.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import * as os from "os";
import * as path from "path";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { ExternalMessage } from "../types.js";
import { CRYPTO_DB_PREFIX, CryptoStoreSnapshotter, restoreCryptoStore } from "./crypto-store.js";
import type { ITransportProvider } from "./interface.js";
import {
  extractUsername,
  formatForMatrix,
  getRetryAfterMs,
  parseVerifyCommand,
  RATE_LIMIT_NOTE,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
} from "./matrix-utils.js";
import { getSecretStorageKey } from "./secret-storage.js";
import { VerificationManager, logVerification, type VerificationNotify, type VerificationSummary } from "./verification.js";

/** One queued outbound request (new message or in-place edit). */
interface OutboundJob {
  kind: "send" | "edit";
  chatId: string;
  text: string;
  /** Target event id — required for edits. */
  messageId?: string;
  resolve: (eventId: string) => void;
  reject: (err: Error) => void;
  /** How many times dispatch has been attempted (for the rate-limit retry cap). */
  attempts: number;
}

/** Give up on a single job after this many rate-limited retries. */
const MAX_SEND_ATTEMPTS = 10;

/** Snapshot the crypto store at most this often while syncing. */
const CRYPTO_SNAPSHOT_DEBOUNCE_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// matrix-js-sdk logs to the console, which corrupts pi's interactive TUI (the
// sync/crypto logs land mid-render, e.g. eating an incoming message). Silence it
// entirely — real connection failures still surface via the transport error
// handler / connect() rejection.
const SILENT_LOGGER: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getChild: () => SILENT_LOGGER,
};

/**
 * Logger for the client: silent on the console (pi's TUI), but verification
 * lines — including matrix-sdk-crypto's own tracing, which reaches us through
 * this logger — are appended to the verification log. That exposes the Rust
 * state machine's view of the SAS/MAC exchange, including contents of events
 * *we* send, which the to-device trace can only see after encryption.
 */
function verificationTracingLogger(): Logger {
  const render = (part: unknown): string => {
    if (typeof part === "string") return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  };
  const capture = (...msg: unknown[]): void => {
    // "OlmMachine" would match a naive /mac/ filter and flood the log.
    const text = msg.map(render).join(" ").replace(/machine/gi, "mchn");
    if (!/verif|sas|mac/i.test(text)) return;
    logVerification(`rust ${text.length > 900 ? `${text.slice(0, 900)}…` : text}`);
  };
  const logger: Logger = {
    trace: capture,
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    getChild: () => logger,
  };
  return logger;
}

/** Bridge data files under ~/.pi */
const STORAGE_DIR = path.join(os.homedir(), ".pi");
const CRYPTO_SNAPSHOT_PATH = path.join(STORAGE_DIR, "matrix-bridge-crypto.json");

/**
 * Matrix transport provider using matrix-js-sdk (Rust/WASM crypto).
 *
 * matrix-bot-sdk's Node crypto bindings cannot do interactive verification, so
 * the transport runs on matrix-js-sdk to get SAS device verification. The Rust
 * crypto store lives in an in-process IndexedDB (fake-indexeddb) that we
 * snapshot to disk — see crypto-store.ts.
 */
export class MatrixProvider implements ITransportProvider {
  readonly type = "matrix";
  private client?: MatrixClient;
  private _isConnected = false;
  private messageHandler?: (message: ExternalMessage) => void;
  /** Last room we received a message in — used to surface TUI-only output in chat. */
  private lastChatId?: string;
  private errorHandler?: (error: Error) => void;
  private botUserId?: string;
  private botDeviceId?: string;
  private joinedRooms = new Set<string>();
  private roomMemberCount = new Map<string, number>();
  private autoJoinAttempted = new Set<string>();
  private connectedAt = 0;
  private cryptoStore?: CryptoStoreSnapshotter;
  private verification?: VerificationManager;
  private verificationNotify?: VerificationNotify;

  // Serialized outbound queue. Every send/edit goes through it so a 429 backs off
  // and retries instead of dropping the message. `rateLimitedUntil` is a global
  // pause (Matrix rate-limits per connection, not per room); `rateLimitNotePending`
  // makes the next new message carry a small "delayed" note.
  private sendQueue: OutboundJob[] = [];
  private processing = false;
  private rateLimitedUntil = 0;
  private rateLimitNotePending = false;

  constructor(
    private config: { homeserverUrl: string; accessToken: string; encryption?: boolean },
    private auth: ChallengeAuth,
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  /** Device ID of this bridge session (available once connected). */
  get deviceId(): string | undefined {
    return this.botDeviceId;
  }

  /** Whether E2EE (and therefore verification) is active. */
  get encryptionEnabled(): boolean {
    return !!this.verification;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { homeserverUrl, accessToken } = this.config;

    if (!homeserverUrl || !accessToken) {
      throw new Error("Matrix homeserver URL and access token required");
    }

    // The access token must be bound to a device: crypto needs a stable device
    // ID, and minting a token from an existing client shares its device (which
    // breaks E2EE). Ask the server who we are before creating the crypto client.
    const probe = createClient({ baseUrl: homeserverUrl, accessToken, logger: SILENT_LOGGER });
    let userId: string;
    let deviceId: string;
    try {
      const who = await probe.whoami();
      if (!who.user_id || !who.device_id) {
        throw new Error(
          who.user_id
            ? "This access token is not bound to a device — mint a fresh token via /login (see README)."
            : "Could not determine the account for this access token.",
        );
      }
      userId = who.user_id;
      deviceId = who.device_id;
    } finally {
      probe.stopClient();
    }

    const encryptionEnabled = this.config.encryption !== false;
    const client = createClient({
      baseUrl: homeserverUrl,
      accessToken,
      userId,
      deviceId,
      store: new MemoryStore(),
      logger: verificationTracingLogger(),
      verificationMethods: ["m.sas.v1"],
      // Only consulted for `/verify sign` (cross-signing from secret storage);
      // returning null keeps everything else offline from the recovery key.
      cryptoCallbacks: { getSecretStorageKey },
    });

    // Register handlers before starting so no early event is missed.
    this.client = client;
    this.botUserId = userId;
    this.botDeviceId = deviceId;

    client.on(RoomEvent.Timeline, this.onTimeline);
    client.on(ClientEvent.Sync, this.onSync);

    try {
      if (encryptionEnabled) {
        // Restore the crypto store *before* the Rust machine opens it, otherwise
        // it generates new device keys (which un-verifies the device).
        await restoreCryptoStore(CRYPTO_SNAPSHOT_PATH);
        await client.initRustCrypto({
          useIndexedDB: true,
          cryptoDatabasePrefix: CRYPTO_DB_PREFIX,
        });
        this.cryptoStore = new CryptoStoreSnapshotter(
          CRYPTO_SNAPSHOT_PATH,
          CRYPTO_SNAPSHOT_DEBOUNCE_MS,
          (err) => this.errorHandler?.(new Error(`Crypto store snapshot failed: ${err.message}`)),
        );
        // Capture the freshly-created account keys right away.
        this.cryptoStore.schedule();
      }

      // No persisted sync token on purpose: the room store is in-memory, and an
      // incremental sync without full room state would make us send unencrypted
      // messages into encrypted rooms. An initial sync with state is cheap.
      await client.startClient({ initialSyncLimit: 0 });
      // Do not report connected (or send anything) until the initial sync has
      // loaded room state — sending into an encrypted room before the
      // m.room.encryption state event is known would go out in plaintext.
      await this.waitForInitialSync(client);

      const crypto = client.getCrypto();
      if (crypto) {
        this.verification = new VerificationManager(client, crypto, (message, level) => {
          this.verificationNotify?.(message, level);
          // Also deliver to the chat: device verification is driven from the
          // other client (Element), so the emoji must be visible there too.
          // `lastChatId` is only known once a message has been received, so
          // right after a reload the emoji message had no destination and was
          // dropped silently — which made the emoji impossible to compare. Fall
          // back to a joined room and log failures instead of swallowing them.
          const chatId = this.lastChatId ?? this.fallbackVerificationRoomId(client);
          if (!chatId) {
            logVerification("notify dropped: no room available to deliver verification messages");
            return;
          }
          void this.sendMessage(chatId, message).catch((err: unknown) => {
            logVerification(`notify delivery to ${chatId} failed: ${(err as Error).message}`);
          });
        });
        this.verification.start();
      }

      // Seed joined rooms and member count caches
      const { joined_rooms: rooms } = await client.getJoinedRooms();
      this.joinedRooms = new Set(rooms);
      await Promise.all(
        rooms.map(async (roomId) => {
          try {
            const members = await client.getJoinedRoomMembers(roomId);
            this.roomMemberCount.set(roomId, Object.keys(members.joined).length);
          } catch {
            // Will be fetched on first message if needed
          }
        }),
      );

      client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
        if (membership === "join") {
          this.joinedRooms.add(room.roomId);
          void client
            .getJoinedRoomMembers(room.roomId)
            .then((members) => this.roomMemberCount.set(room.roomId, Object.keys(members.joined).length))
            .catch(() => {});
        } else {
          this.joinedRooms.delete(room.roomId);
          this.roomMemberCount.delete(room.roomId);
        }
      });
    } catch (error) {
      // Clean up dangling state so connect() can be retried
      await this.teardown();
      throw error;
    }

    this.connectedAt = Date.now();
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.client) return;

    // Fail any queued sends so awaiting callers don't hang on a dead connection.
    const pending = this.sendQueue;
    this.sendQueue = [];
    this.rateLimitedUntil = 0;
    this.rateLimitNotePending = false;
    for (const job of pending) {
      job.reject(new Error("Matrix transport disconnected"));
    }

    await this.teardown();
  }

  /** Stop crypto/verification/sync and release all per-connection state. */
  private async teardown(): Promise<void> {
    this.verification?.dispose();
    this.verification = undefined;

    // Final crypto snapshot before the in-memory store vanishes.
    if (this.cryptoStore) {
      this.cryptoStore.schedule();
      await this.cryptoStore.close();
      this.cryptoStore = undefined;
    }

    const client = this.client;
    if (client) {
      client.off(RoomEvent.Timeline, this.onTimeline);
      client.off(ClientEvent.Sync, this.onSync);
      try {
        client.stopClient();
      } catch {
        // already stopped
      }
    }

    this._isConnected = false;
    this.client = undefined;
    this.botUserId = undefined;
    this.botDeviceId = undefined;
    this.joinedRooms.clear();
    this.roomMemberCount.clear();
    this.autoJoinAttempted.clear();
    this.connectedAt = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* verification                                                           */
  /* ---------------------------------------------------------------------- */

  /** Register a handler for verification progress (emoji, completion, errors). */
  onVerificationNotification(handler: VerificationNotify): void {
    this.verificationNotify = handler;
  }

  /**
   * Handle `/verify …` from the chat. Returns nothing; replies into the room.
   * Kept off the agent path so the SAS handshake does not depend on a model turn.
   */
  private async handleVerifyCommand(text: string, chatId: string): Promise<void> {
    const manager = this.verification;
    const command = parseVerifyCommand(text);
    if (!manager || !command) return;

    const reply = async (message: string): Promise<void> => {
      await this.sendMessage(chatId, message).catch(() => {});
    };

    try {
      switch (command.action) {
        case "list": {
          const pending = manager.list();
          if (pending.length === 0) {
            await reply(
              [
                "No device verification in progress.",
                `Bridge device: ${this.deviceId ?? "unknown"}`,
                "Start one in Element: Settings → Sessions → select the bridge session → Verify.",
              ].join("\n"),
            );
            return;
          }
          const lines = ["━━━ Pending verifications ━━━"];
          for (const entry of pending) {
            lines.push(`${entry.id}  ${entry.userId} ${entry.deviceId ?? ""}  [${entry.phase}]`);
            if (entry.emoji?.length) lines.push(`  emoji: ${entry.emoji.join(" ")}`);
            if (entry.decimal?.length) lines.push(`  numbers: ${entry.decimal.join(" ")}`);
          }
          lines.push(
            "",
            "Match?  /verify accept <id>   No match?  /verify mismatch <id>",
            "Nothing pending?  /verify start <deviceId>  initiates from the bridge.",
            "SAS keeps failing?  /verify sign <deviceId>  cross-signs directly (recovery key file).",
            "SAS times out?  /verify auto on  accepts the emoji automatically (compare them yourself!).",
          );
          await reply(lines.join("\n"));
          return;
        }
        case "start":
          if (!command.id) return await reply("Usage: /verify start <deviceId> (e.g. /verify start daZejMzfih)");
          await manager.request(command.id);
          return;
        case "auto": {
          const value = (command.id ?? "").toLowerCase();
          if (value !== "on" && value !== "off") return await reply("Usage: /verify auto on|off");
          manager.setAutoConfirm(value === "on");
          return;
        }
        case "sign":
          if (!command.id) return await reply("Usage: /verify sign <deviceId> (e.g. /verify sign CONTOXFROGBOT)");
          await manager.crossSignOwnDevice(command.id);
          return;
        case "accept":
          if (!command.id) return await reply("Usage: /verify accept <id>");
          await manager.accept(command.id);
          return;
        case "mismatch":
          if (!command.id) return await reply("Usage: /verify mismatch <id>");
          await manager.mismatch(command.id);
          return;
        case "cancel":
          if (!command.id) return await reply("Usage: /verify cancel <id>");
          await manager.cancel(command.id);
          return;
      }
    } catch (err) {
      await reply(`❌ ${(err as Error).message}`);
    }
  }

  listVerifications(): VerificationSummary[] {
    return this.verification?.list() ?? [];
  }

  /** Enable/disable automatic SAS confirmation (`/matrix-bridge verify auto on`). */
  setVerificationAutoConfirm(enabled: boolean): void {
    this.requireVerification().setAutoConfirm(enabled);
  }

  /** Start verification from the bridge side (`/matrix-bridge verify start <device>`). */
  async startVerification(deviceId: string): Promise<string> {
    return await this.requireVerification().request(deviceId);
  }

  /** Cross-sign one of our own devices without SAS (`/matrix-bridge verify sign <device>`). */
  async crossSignDevice(deviceId: string): Promise<void> {
    await this.requireVerification().crossSignOwnDevice(deviceId);
  }

  async acceptVerification(id: string): Promise<void> {
    await this.requireVerification().accept(id);
  }

  async mismatchVerification(id: string): Promise<void> {
    await this.requireVerification().mismatch(id);
  }

  async cancelVerification(id: string): Promise<void> {
    await this.requireVerification().cancel(id);
  }

  /**
   * Somewhere to post verification messages before the user has spoken in a
   * room: prefer an encrypted room (verification needs E2EE), else any joined.
   */
  private fallbackVerificationRoomId(client: MatrixClient): string | undefined {
    const rooms = client.getRooms?.() ?? [];
    const encrypted = rooms.find((room) => room.hasEncryptionStateEvent?.());
    return (encrypted ?? rooms[0])?.roomId;
  }

  private requireVerification(): VerificationManager {
    if (!this.verification) {
      throw new Error(
        "Verification is unavailable — E2EE is disabled or the bridge is not connected.",
      );
    }
    return this.verification;
  }

  /* ---------------------------------------------------------------------- */
  /* outbound                                                               */
  /* ---------------------------------------------------------------------- */

  async sendMessage(chatId: string, text: string): Promise<string> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }
    if (!text?.trim()) return "";

    return this.enqueue({ kind: "send", chatId, text });
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client || !messageId || !text?.trim()) return;

    await this.enqueue({ kind: "edit", chatId, messageId, text });
  }

  /**
   * Append a job to the outbound queue and start the processor. Consecutive
   * pending edits to the same message are coalesced (the queued text is replaced)
   * so a backoff doesn't flush a run of stale intermediate edits.
   */
  private enqueue(spec: Pick<OutboundJob, "kind" | "chatId" | "text" | "messageId">): Promise<string> {
    if (spec.kind === "edit") {
      const pendingUpdate = this.findCoalescableEdit(spec.chatId, spec.messageId);
      if (pendingUpdate) {
        pendingUpdate.text = spec.text;
        return new Promise((resolve, reject) => {
          // Ride along with the existing job's outcome.
          const prevResolve = pendingUpdate.resolve;
          const prevReject = pendingUpdate.reject;
          pendingUpdate.resolve = (id) => {
            prevResolve(id);
            resolve(id);
          };
          pendingUpdate.reject = (err) => {
            prevReject(err);
            reject(err);
          };
        });
      }
    }

    return new Promise<string>((resolve, reject) => {
      this.sendQueue.push({ ...spec, resolve, reject, attempts: 0 });
      void this.processQueue();
    });
  }

  /** Find a not-yet-dispatched edit for the same message that can be coalesced. */
  private findCoalescableEdit(chatId: string, messageId?: string): OutboundJob | undefined {
    if (!messageId) return undefined;
    // Skip the head while it's actively being dispatched — only later jobs are safe to mutate.
    const start = this.processing ? 1 : 0;
    for (let i = start; i < this.sendQueue.length; i++) {
      const job = this.sendQueue[i];
      if (job.kind === "edit" && job.chatId === chatId && job.messageId === messageId) {
        return job;
      }
    }
    return undefined;
  }

  /**
   * Drain the outbound queue one job at a time, honoring the rate-limit backoff.
   * On a 429 the head job stays in place and is retried after the server's
   * retry_after delay; other errors reject the job and move on.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.sendQueue.length > 0) {
        const wait = this.rateLimitedUntil - Date.now();
        if (wait > 0) await sleep(wait);

        const job = this.sendQueue[0];
        job.attempts++;
        try {
          const eventId = await this.dispatch(job);
          this.sendQueue.shift();
          job.resolve(eventId);
        } catch (err) {
          const retryMs = getRetryAfterMs(err);
          if (retryMs != null && job.attempts < MAX_SEND_ATTEMPTS) {
            // Rate limited: pause all sends, flag the note, retry this same job.
            this.rateLimitedUntil = Date.now() + retryMs;
            this.rateLimitNotePending = true;
          } else {
            this.sendQueue.shift();
            job.reject(err as Error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Perform the actual SDK call for a single queued job. */
  private async dispatch(job: OutboundJob): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("Matrix client not connected");

    // Refuse to send into a room we have no state for: matrix-js-sdk decides
    // whether to encrypt from the room's m.room.encryption state, so sending
    // before state is loaded could leak plaintext into an encrypted room.
    if (!client.getRoom(job.chatId)) {
      throw new Error(`Room ${job.chatId} is not ready (room state not loaded yet)`);
    }

    if (job.kind === "send") {
      let text = job.text;
      if (this.rateLimitNotePending) {
        text = `${RATE_LIMIT_NOTE}\n\n${text}`;
        this.rateLimitNotePending = false;
      }
      const { body, formattedBody } = formatForMatrix(text);
      const content = {
        msgtype: "m.text",
        body,
        ...(formattedBody && {
          format: "org.matrix.custom.html",
          formatted_body: formattedBody,
        }),
      } as RoomMessageEventContent;
      const res = await client.sendMessage(job.chatId, content);
      return res.event_id;
    }

    const { body, formattedBody } = formatForMatrix(job.text);
    const newContent = {
      msgtype: "m.text",
      body,
      ...(formattedBody && {
        format: "org.matrix.custom.html",
        formatted_body: formattedBody,
      }),
    };

    // m.replace edit. The top-level body carries the "* " fallback shown by
    // clients that don't render edits; m.new_content holds the real replacement.
    const res = await client.sendMessage(job.chatId, {
      ...newContent,
      body: `* ${body}`,
      ...(formattedBody && { formatted_body: `* ${formattedBody}` }),
      "m.new_content": newContent,
      "m.relates_to": { rel_type: "m.replace", event_id: job.messageId },
    } as RoomMessageEventContent);
    return res.event_id ?? "";
  }

  async sendTyping(chatId: string): Promise<void> {
    // Don't pile typing requests onto a server that's already rate-limiting us.
    if (!this.client || this.rateLimitedUntil > Date.now()) return;
    try {
      await this.client.sendTyping(chatId, true, 10000);
    } catch {
      // Ignore typing indicator errors
    }
  }

  async stopTyping(chatId: string): Promise<void> {
    if (!this.client || this.rateLimitedUntil > Date.now()) return;
    try {
      await this.client.sendTyping(chatId, false, 0);
    } catch {
      // Ignore typing indicator errors
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /* ---------------------------------------------------------------------- */
  /* inbound                                                                */
  /* ---------------------------------------------------------------------- */

  /** Called for every live timeline event (already filtered to room messages). */
  private onTimeline = (event: MatrixEvent, room?: Room): void => {
    void this.handleTimelineEvent(event, room).catch((err) => {
      this.errorHandler?.(err as Error);
    });
  };

  /** Snapshot the crypto store after syncs (it changes with almost every sync). */
  private onSync = (state: SyncState): void => {
    if (state === SyncState.Syncing || state === SyncState.Prepared || state === SyncState.Catchup) {
      this.cryptoStore?.schedule();
      this.autoJoinInvites();
    }
  };

  /**
   * matrix-bot-sdk's AutojoinRoomsMixin has no matrix-js-sdk equivalent, so
   * join invites ourselves. Called on every sync; joined rooms are skipped and
   * failures are not retried for the same room.
   */
  private autoJoinInvites(): void {
    const client = this.client;
    if (!client) return;
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "invite" || this.autoJoinAttempted.has(room.roomId)) continue;
      this.autoJoinAttempted.add(room.roomId);
      client.joinRoom(room.roomId).catch(() => {
        // Retry after a reconnect, not in a tight loop.
        this.autoJoinAttempted.delete(room.roomId);
      });
    }
  }

  /** Resolve once the first sync has delivered room state. */
  private async waitForInitialSync(client: MatrixClient, timeoutMs = 60_000): Promise<void> {
    const current = client.getSyncState();
    if (current === SyncState.Prepared || current === SyncState.Syncing) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        client.off(ClientEvent.Sync, onSync);
      };
      const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          cleanup();
          resolve();
        } else if (state === SyncState.Error || state === SyncState.Stopped) {
          cleanup();
          reject(data?.error ?? new Error("Matrix sync failed"));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the initial Matrix sync"));
      }, timeoutMs);
      timer.unref?.();
      client.on(ClientEvent.Sync, onSync);
    });
  }

  private async handleTimelineEvent(event: MatrixEvent, room?: Room): Promise<void> {
    const client = this.client;
    if (!client || !this.botUserId) return;

    const type = event.getType();
    if (type !== "m.room.message" && type !== "m.room.encrypted") return;

    // Decrypt on demand; the SDK does not pre-decrypt message events. This
    // resolves immediately for unencrypted events.
    if (event.isEncrypted()) {
      await client.decryptEventIfNeeded(event);
      if (event.isDecryptionFailure()) return; // leave a debug trail? silently skip
    }

    const content = event.getContent();
    if (event.getType() !== "m.room.message" || !content) return;

    const roomId = event.getRoomId() ?? room?.roomId;
    if (!roomId) return;

    // Remote echo of our own send — already handled the local echo.
    if (event.getUnsigned()?.transaction_id) return;

    const sender = event.getSender() ?? "";
    // Plain shape reused by the pure, tested filtering helpers.
    const plainEvent = {
      sender,
      origin_server_ts: event.getTs(),
      content,
    };

    // Pure filter — delegates to testable utility
    const skipReason = shouldSkipEvent(plainEvent, this.botUserId, this.connectedAt, this.joinedRooms, roomId);
    if (skipReason) return;

    const chatId = roomId;
    this.lastChatId = chatId;
    const username = extractUsername(sender);
    const messageText = content.body as string;
    const messageId = event.getId() ?? "";

    // Determine if group chat from cached member count (no API call per message)
    let memberCount = this.roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      // Cache miss — fetch once and cache
      try {
        const members = await client.getJoinedRoomMembers(roomId);
        memberCount = Object.keys(members.joined).length;
        this.roomMemberCount.set(roomId, memberCount);
      } catch {
        memberCount = 2; // Default to DM if we can't check
      }
    }
    const isGroupChat = memberCount > 2;

    // Check if bot was mentioned (pure utility)
    const wasMentioned = isGroupChat ? wasBotMentioned(messageText, this.botUserId) : false;

    // Check authorization
    const sendMessageToUser = async (cId: string, text: string) => {
      await this.sendMessage(cId, text);
    };

    const isAuthorized = await this.auth.checkAuthorization(
      sender,
      chatId,
      username,
      isGroupChat,
      wasMentioned,
      sendMessageToUser,
      this.type,
    );

    // Handle challenge codes and commands in DMs. Admin commands accept either
    // a / or ! prefix (normalised in handleAdminCommand).
    if (!isGroupChat && (messageText.startsWith("/") || messageText.startsWith("!") || messageText.match(/^\d{6}$/))) {
      const handled = await this.auth.handleAdminCommand(
        messageText,
        chatId,
        sender,
        async (text) => {
          await this.sendMessage(chatId, text);
        },
        this.type,
      );
      if (handled) return;
    }

    if (!isAuthorized) return;

    // Device verification driven from chat: /verify [list|accept|mismatch|cancel <id>]
    if (this.verification && parseVerifyCommand(messageText)) {
      await this.handleVerifyCommand(messageText, chatId);
      return;
    }

    // Strip bot mention from message (pure utility)
    const cleanContent =
      wasMentioned && this.botUserId ? stripBotMention(messageText, this.botUserId) : messageText;

    // Forward to message handler
    if (this.messageHandler && cleanContent) {
      const externalMessage: ExternalMessage = {
        chatId,
        transport: this.type,
        content: cleanContent,
        username,
        userId: sender,
        timestamp: new Date(event.getTs() || Date.now()),
        messageId,
        isGroupChat,
        wasMentioned,
      };

      this.messageHandler(externalMessage);
    }
  }
}
