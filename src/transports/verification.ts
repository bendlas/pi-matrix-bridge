/**
 * SAS (emoji/decimal) device verification for the Matrix transport.
 *
 * Thin wrapper around matrix-js-sdk's `CryptoApi`: the Rust crypto stack does
 * all of the DH/HKDF/commitment/MAC work and encrypted to-device delivery, so
 * this file only drives the flow and surfaces the emoji to the pi TUI.
 *
 * Flow (user initiates from Element → Settings → Sessions → "Verify session"):
 *
 *   Element            bridge (this file)
 *     request   ──────►  auto-accepted
 *     ready     ◄──────  auto-accepted
 *     start     ──────►  peer starts SAS; we adopt its verifier
 *                        (only when *we* initiated do we send `start`)
 *     key/accepted ...   SDK
 *     (emoji shown here) notify, wait for /matrix-bridge verify accept
 *     mac       ◄──────  confirm() sends our MAC
 *     done               verified
 *
 * Both sides must confirm, so the bot cannot fully auto-confirm: the user reads
 * the emoji in the pi terminal, compares them with Element, and confirms via
 * `/matrix-bridge verify accept <id>`.
 */

import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import type { CryptoApi, ShowSasCallbacks, VerificationRequest, Verifier } from "matrix-js-sdk/lib/crypto-api/index.js";
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Debug trail for verification: the flow is otherwise invisible from chat. */
const VERIFY_LOG_PATH = path.join(os.homedir(), ".pi", "matrix-bridge-verify.log");
const VERIFY_LOG_MAX_BYTES = 128 * 1024;

export function logVerification(line: string): void {
  // Unit tests exercise the manager heavily; keep their fake transactions out of
  // the operator-facing log.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    if (fs.existsSync(VERIFY_LOG_PATH) && fs.statSync(VERIFY_LOG_PATH).size > VERIFY_LOG_MAX_BYTES) {
      fs.renameSync(VERIFY_LOG_PATH, `${VERIFY_LOG_PATH}.1`);
    }
    fs.appendFileSync(VERIFY_LOG_PATH, entry, { mode: 0o600 });
  } catch {
    // Logging must never break verification.
  }
}

export type VerificationNotifyLevel = "info" | "warning" | "error";
export type VerificationNotify = (message: string, level: VerificationNotifyLevel) => void;

/** One in-flight (or just-finished) verification, as shown by `verify list`. */
export interface VerificationSummary {
  /** Handle accepted by `verify accept/cancel/mismatch`. Usually the transaction ID. */
  id: string;
  userId: string;
  deviceId?: string;
  phase: string;
  /** Emoji shown for comparison, once the SAS has been exchanged. */
  emoji?: string[];
  /** Decimal SAS, once the SAS has been exchanged. */
  decimal?: number[];
}

interface PendingVerification {
  id: string;
  request: VerificationRequest;
  verifier?: Verifier;
  sas?: ShowSasCallbacks;
  started: boolean;
  /** Our listeners, so cleanup removes only ours (not the SDK's own). */
  cleanups: Array<() => void>;
}

/**
 * Compact rendering of a verification event for the debug log. Keeps MACs and
 * keys (public material) but drops nothing else — the point is diagnosability.
 */
function summarize(content: Record<string, unknown>): string {
  const text = JSON.stringify(content);
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

/** Human-readable phase name for logging/listing. */
function phaseName(phase: VerificationPhase): string {
  switch (phase) {
    case VerificationPhase.Unsent:
      return "unsent";
    case VerificationPhase.Requested:
      return "requested";
    case VerificationPhase.Ready:
      return "ready";
    case VerificationPhase.Started:
      return "started";
    case VerificationPhase.Cancelled:
      return "cancelled";
    case VerificationPhase.Done:
      return "done";
    default:
      return `unknown(${String(phase)})`;
  }
}

export class VerificationManager {
  private readonly pending = new Map<string, PendingVerification>();
  /**
   * Opt-in (`/verify auto on`): confirm the emoji as soon as they appear.
   *
   * The Rust SDK cancels a SAS that sees no progress after 60 s, which leaves no
   * room to both click "They match" in the other client *and* type a command in
   * chat. Auto-confirm is off by default because it removes the human
   * comparison — it exists for flows where the emoji have already been checked.
   */
  private autoConfirm = false;
  private readonly onRequestReceived = (request: VerificationRequest): void => {
    void this.track(request);
  };

  constructor(
    private readonly client: MatrixClient,
    private readonly crypto: CryptoApi,
    private readonly notify: VerificationNotify,
  ) {}

  /** Surface a message to the user and to the debug log. */
  private emit(message: string, level: VerificationNotifyLevel): void {
    logVerification(`[${level}] ${message.replace(/\n/g, " | ")}`);
    this.notify(message, level);
  }

  /** Start listening for verification requests. Safe to call once. */
  start(): void {
    this.client.on(CryptoEvent.VerificationRequestReceived, this.onRequestReceived);
    this.traceToDevice();
  }

  /**
   * Log every `m.key.verification.*` to-device event in both directions.
   *
   * The SAS flow is invisible otherwise: when the peer cancels with
   * `m.mismatched_sas` the only way to tell a key-set disagreement (stale peer
   * device keys) from a crossed flow (two SAS computations, duplicate `start`s)
   * is the raw event contents — commitments, public keys, and MAC key ids.
   */
  private traceToDevice(): void {
    // Incoming (already decrypted by the SDK, so we see the real event type).
    const onToDevice = (event: MatrixEvent): void => {
      try {
        const type = event.getType();
        if (!type.startsWith("m.key.verification.")) return;
        const content = event.getContent() as Record<string, unknown>;
        logVerification(
          `wire in  ${type} from=${event.getSender() ?? "?"}/${event.getSenderKey?.() ?? (content.from_device as string) ?? "?"} ${summarize(content)}`,
        );
      } catch {
        // Tracing must never break the flow.
      }
    };
    this.client.on(ClientEvent.ToDeviceEvent, onToDevice);

    // Outgoing: wrap the send path so our own events are logged too. Guarded so
    // partial clients (tests, mocks) still work.
    if (typeof this.client.encryptAndSendToDevice !== "function") return;
    const original = this.client.encryptAndSendToDevice.bind(this.client);
    this.client.encryptAndSendToDevice = (async (eventType, devices, payload) => {
      if (eventType.startsWith("m.key.verification.")) {
        const targets = devices.map((d) => `${d.userId}/${d.deviceId}`).join(",");
        logVerification(
          `wire out ${eventType} to=${targets} ${summarize(payload as Record<string, unknown>)}`,
        );
      }
      return original(eventType, devices, payload);
    }) as typeof this.client.encryptAndSendToDevice;
  }

  /**
   * Stop listening and cancel anything still in flight (e.g. on disconnect, so
   * the other side isn't left waiting for a 10 minute timeout).
   */
  dispose(): void {
    this.client.off(CryptoEvent.VerificationRequestReceived, this.onRequestReceived);
    for (const entry of this.pending.values()) {
      entry.request.cancel({ code: "m.user", reason: "Bridge disconnected" }).catch(() => {});
    }
    this.pending.clear();
  }

  /**
   * Initiate verification with one of the account's own devices, so the bridge
   * is the initiator (the mirror of the Element-initiated flow).
   */
  async request(deviceId: string): Promise<string> {
    const userId = this.client.getUserId();
    if (!userId) throw new Error("Cannot start verification: not logged in");
    const request = await this.crypto.requestDeviceVerification(userId, deviceId);
    const id = request.transactionId ?? `${userId}:${deviceId}`;
    await this.track(request);
    this.emit(
      `🔐 Requested verification with ${deviceId} (id ${id}) — accept it in Element, then compare the emoji.`,
      "info",
    );
    return id;
  }

  /**
   * Cross-sign one of the account's own devices directly, without SAS.
   *
   * Uses the self-signing key from secret storage (recovery key in
   * ~/.pi/matrix-bridge-recovery-key), i.e. the same authority as comparing the
   * emoji, but independent of the peer's device-key view.
   */
  async crossSignOwnDevice(deviceId: string): Promise<void> {
    const userId = this.client.getUserId();
    if (!userId) throw new Error("Cannot cross-sign: not logged in");

    if (!(await this.crypto.isCrossSigningReady())) {
      logVerification(`crossSign ${deviceId}: bootstrapping cross-signing from secret storage`);
      await this.crypto.bootstrapCrossSigning({ setupNewCrossSigning: false });
    }
    if (!(await this.crypto.isCrossSigningReady())) {
      throw new Error(
        "Cross-signing keys unavailable — check ~/.pi/matrix-bridge-recovery-key (base58 or hex, mode 600) matches this account's recovery key.",
      );
    }

    await this.crypto.crossSignDevice(deviceId);
    logVerification(`crossSign ${deviceId}: signed with the self-signing key`);

    const status = await this.crypto.getDeviceVerificationStatus(userId, deviceId);
    if (status?.crossSigningVerified) {
      this.emit(`✅ ${deviceId} is now cross-signed — this session is verified.`, "info");
    } else {
      this.emit(
        `⚠️ Signed ${deviceId}, but the device does not report as cross-signed yet. Reload Element to refresh its device view.`,
        "warning",
      );
    }
  }

  /** Enable/disable automatic SAS confirmation (see `autoConfirm`). */
  setAutoConfirm(enabled: boolean): void {
    this.autoConfirm = enabled;
    logVerification(`autoConfirm=${enabled}`);
    this.emit(
      enabled
        ? "⚡ Auto-confirm enabled: SAS values are accepted automatically as soon as they appear. Compare the emoji carefully — no confirmation will be asked."
        : "🛑 Auto-confirm disabled: confirmation is required again.",
      enabled ? "warning" : "info",
    );
  }

  /** In-flight verifications. */
  list(): VerificationSummary[] {
    return Array.from(this.pending.values()).map((entry) => ({
      id: entry.id,
      userId: entry.request.otherUserId,
      deviceId: entry.request.otherDeviceId,
      phase: phaseName(entry.request.phase),
      emoji: entry.sas?.sas.emoji?.map(([emoji]) => emoji),
      decimal: entry.sas?.sas.decimal,
    }));
  }

  /**
   * Confirm that the emoji/numbers matched. This completes verification; call it
   * only after the user has compared the values with the other device.
   */
  async accept(id: string): Promise<void> {
    const entry = this.require(id);
    if (!entry.sas) {
      throw new Error(
        `Verification ${id} has not exchanged SAS yet — wait for the emoji to appear (verify list).`,
      );
    }
    logVerification(`confirm id=${id} device=${entry.request.otherDeviceId ?? "?"}`);
    await entry.sas.confirm();
    this.emit(`✅ Confirmed SAS for ${entry.request.otherDeviceId ?? entry.request.otherUserId}. Finishing verification…`, "info");
  }

  /** Reject because the values did not match (sends `m.mismatched_sas`). */
  async mismatch(id: string): Promise<void> {
    const entry = this.require(id);
    if (entry.sas) {
      entry.sas.mismatch();
    } else {
      await entry.request.cancel({ code: "m.mismatched_sas", reason: "Values did not match" });
    }
    this.emit(`❌ Reported SAS mismatch for ${entry.id}.`, "warning");
  }

  /** Abort for any other reason. */
  async cancel(id: string): Promise<void> {
    const entry = this.require(id);
    await entry.request.cancel({ code: "m.user", reason: "Cancelled from pi" });
    this.emit(`⏹️ Cancelled verification ${entry.id}.`, "info");
  }

  /* ---------------------------------------------------------------------- */

  private require(id: string): PendingVerification {
    const trimmed = id.trim();
    const exact = this.pending.get(trimmed);
    if (exact) return exact;
    // Accept a unique prefix, so the short IDs from `verify list` are usable.
    const matches = Array.from(this.pending.values()).filter((entry) => entry.id.startsWith(trimmed));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous verification id "${id}" — use one of: ${matches.map((m) => m.id).join(", ")}`);
    }
    const known = Array.from(this.pending.keys());
    throw new Error(
      known.length
        ? `No verification "${id}". In flight: ${known.join(", ")}`
        : `No verification "${id}". Start one from Element (Settings → Sessions → verify this session).`,
    );
  }

  private async track(request: VerificationRequest): Promise<void> {
    if (!request.isSelfVerification) {
      // Only the account's own devices may verify the bridge.
      this.emit(
        `Ignoring verification request from ${request.otherUserId} — only the account's own devices can verify the bridge.`,
        "warning",
      );
      return;
    }

    const id = request.transactionId ?? `${request.otherUserId}:${request.otherDeviceId ?? "unknown"}`;
    logVerification(
      `request id=${id} from ${request.otherUserId}/${request.otherDeviceId ?? "?"} phase=${phaseName(request.phase)} self=${request.isSelfVerification} initiatedByMe=${request.initiatedByMe}`,
    );
    if (this.pending.has(id)) return;

    const entry: PendingVerification = { id, request, started: false, cleanups: [] };
    this.pending.set(id, entry);

    const onChange = (): void => this.onChange(entry);
    request.on(VerificationRequestEvent.Change, onChange);
    entry.cleanups.push(() => request.off(VerificationRequestEvent.Change, onChange));

    this.emit(
      `🔐 Verification requested by ${request.otherUserId} (${request.otherDeviceId ?? "unknown device"}) — accepting…`,
      "info",
    );

    // Only accept in the phases where accepting is legal: the other side may
    // already have sent `start` (e.g. a re-delivered request), in which case we
    // adopt the existing verifier below instead of sending `ready`.
    if (request.phase === VerificationPhase.Unsent || request.phase === VerificationPhase.Requested) {
      try {
        await request.accept();
      } catch (err) {
        this.emit(`⚠️ Could not accept verification ${id}: ${(err as Error).message}`, "warning");
        this.finish(entry);
        return;
      }
    }
    // The request may already be ready/started by the time we get here.
    this.onChange(entry);
  }

  private onChange(entry: PendingVerification): void {
    const { request } = entry;
    const phase = request.phase;
    logVerification(
      `change id=${entry.id} phase=${phaseName(phase)} verifier=${request.verifier ? "yes" : "no"} started=${entry.started}`,
    );

    // Only the initiator sends `m.key.verification.start`. As the responder we
    // accept and then wait for the peer's start (adopted below). Sending our own
    // start here raced Element's, giving two independent SAS computations whose
    // MACs disagree — the peer then cancels with `m.mismatched_sas`.
    //
    // NB: do not read `request.methods` here. matrix-js-sdk's rust-crypto shim
    // deliberately throws "not implemented" for that getter, and because
    // `accept()` ends with a synchronous `emit(Change)` the throw would
    // propagate back out of `accept()`. `startVerification` below rejects with a
    // real error if the other side does not support SAS.
    if (phase === VerificationPhase.Ready && !entry.started && request.initiatedByMe) {
      void this.startSas(entry);
      return;
    }

    if (phase === VerificationPhase.Started && request.verifier) {
      // Covers the case where the other side sent `start` directly.
      this.adoptVerifier(entry, request.verifier);
      return;
    }

    if (phase === VerificationPhase.Done) {
      this.finish(entry);
      void this.reportVerificationResult(entry);
      return;
    }

    if (phase === VerificationPhase.Cancelled) {
      const code = request.cancellationCode ?? "unknown";
      this.emit(
        `⚠️ Verification ${entry.id} was cancelled (${code}) by ${request.cancellingUserId ?? "the other side"}.`,
        "warning",
      );
      this.finish(entry);
    }
  }

  private async startSas(entry: PendingVerification): Promise<void> {
    entry.started = true;
    try {
      const verifier = await entry.request.startVerification("m.sas.v1");
      this.adoptVerifier(entry, verifier);
    } catch (err) {
      // Usually "method not supported by the other side" — cancel so the peer is
      // not left waiting for the 10 minute timeout.
      this.emit(`⚠️ Could not start SAS verification ${entry.id}: ${(err as Error).message}`, "error");
      void entry.request
        .cancel({ code: "m.unknown_method", reason: "SAS (m.sas.v1) not supported" })
        .catch(() => {});
      this.finish(entry);
    }
  }

  private adoptVerifier(entry: PendingVerification, verifier: Verifier): void {
    if (entry.verifier) return;
    entry.verifier = verifier;
    const onShowSas = (callbacks: ShowSasCallbacks): void => this.showSas(entry, callbacks);
    const onCancel = (reason: Error | unknown): void => {
      const detail = reason instanceof Error ? reason.message : "cancelled";
      this.emit(`⚠️ SAS verification ${entry.id} cancelled: ${detail}`, "warning");
      this.finish(entry);
    };
    verifier.on(VerifierEvent.ShowSas, onShowSas);
    verifier.on(VerifierEvent.Cancel, onCancel);
    entry.cleanups.push(() => {
      verifier.off(VerifierEvent.ShowSas, onShowSas);
      verifier.off(VerifierEvent.Cancel, onCancel);
    });
    // The SAS may have been ready before we attached the listener.
    const existing = verifier.getShowSasCallbacks();
    if (existing) this.showSas(entry, existing);

    // Drive the flow: `verify()` sends our `m.key.verification.accept` (or the
    // `start` when we are the initiator) and kicks off the key exchange. Without
    // it the peer waits forever and no emoji are ever derived. It resolves only
    // when the whole verification finishes, so it must not be awaited here.
    void verifier.verify().catch((err: unknown) => {
      this.emit(`⚠️ Verification ${entry.id} did not complete: ${(err as Error).message}`, "warning");
      this.finish(entry);
    });
  }

  private showSas(entry: PendingVerification, callbacks: ShowSasCallbacks): void {
    if (entry.sas) return; // already displayed for this flow
    entry.sas = callbacks;

    const emoji = callbacks.sas.emoji?.map(([glyph]) => glyph).join(" ");
    logVerification(`showSas id=${entry.id} emoji=${emoji} decimal=${callbacks.sas.decimal?.join(" ")}`);
    const decimal = callbacks.sas.decimal?.join(" ");
    const values = [
      emoji ? `Emoji:  ${emoji}` : null,
      decimal ? `Numbers: ${decimal}` : null,
    ].filter(Boolean).join("\n");
    const device = entry.request.otherDeviceId ?? entry.request.otherUserId;

    this.emit(
      [
        `🔐 Verify bridge device ${device} — compare with Element:`,
        values || "(no SAS values received)",
        "",
        `Match?  /matrix-bridge verify accept ${entry.id}`,
        `No match?  /matrix-bridge verify mismatch ${entry.id}`,
        `Abort?  /matrix-bridge verify cancel ${entry.id}`,
      ].join("\n"),
      "info",
    );

    if (this.autoConfirm) {
      logVerification(`autoConfirm id=${entry.id}`);
      void callbacks.confirm().catch((err: unknown) => {
        this.emit(`⚠️ Auto-confirm failed for ${entry.id}: ${(err as Error).message}`, "warning");
      });
    }
  }

  private async reportVerificationResult(entry: PendingVerification): Promise<void> {
    const deviceId = entry.request.otherDeviceId;
    if (!deviceId) {
      this.emit("✅ Verification complete.", "info");
      return;
    }
    try {
      const status = await this.crypto.getDeviceVerificationStatus(entry.request.otherUserId, deviceId);
      if (status?.crossSigningVerified) {
        this.emit(`✅ Device ${deviceId} is now verified (cross-signed).`, "info");
      } else if (status?.signedByOwner) {
        this.emit(`✅ Device ${deviceId} is verified for this session.`, "info");
      } else {
        this.emit(
          `✅ SAS verification with ${deviceId} completed. Note: the device is not cross-signed yet — Element will show it as verified only while this session is running.`,
          "warning",
        );
      }
    } catch {
      this.emit("✅ Verification complete.", "info");
    }
  }

  private finish(entry: PendingVerification): void {
    for (const cleanup of entry.cleanups) {
      try {
        cleanup();
      } catch {
        // listener already gone
      }
    }
    entry.cleanups = [];
    this.pending.delete(entry.id);
  }
}
