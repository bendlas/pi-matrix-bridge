import { VerificationPhase } from "matrix-js-sdk/lib/crypto-api/index.js";
import { describe, expect, it, vi } from "vitest";
import { VerificationManager } from "../src/transports/verification.js";

/**
 * Regression: matrix-js-sdk's rust-crypto shim throws "not implemented" from
 * `VerificationRequest.methods`, and `accept()` ends with a synchronous
 * `emit(Change)`, so touching `methods` inside the change handler surfaced as
 * "Could not accept verification <id>: not implemented" and silently killed the
 * flow. The manager must drive SAS without ever reading `methods`.
 */

type ChangeHandler = () => void;

class FakeVerifier {
  handlers = new Map<string, (...args: unknown[]) => void>();
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  off(event: string): this {
    this.handlers.delete(event);
    return this;
  }
  getShowSasCallbacks(): undefined {
    return undefined;
  }
  /** The SDK requires this call: sends our accept/start and starts the exchange. */
  verify = vi.fn(async () => {});
}

class FakeRequest {
  phase = VerificationPhase.Requested;
  readonly transactionId = "txn-1";
  readonly otherUserId = "@frogbot:bendlas.net";
  readonly otherDeviceId = "daZejMzfih";
  readonly isSelfVerification = true;
  initiatedByMe = false;
  cancellationCode: string | undefined = undefined;
  cancellingUserId: string | undefined = undefined;
  verifier: FakeVerifier | undefined = undefined;
  accept = vi.fn(async () => {
    // Mirror the SDK: accept() emits synchronously from inside the promise body.
    this.phase = VerificationPhase.Ready;
    this.emit();
  });
  startVerification = vi.fn(async () => {
    const verifier = new FakeVerifier();
    this.verifier = verifier;
    this.phase = VerificationPhase.Started;
    return verifier;
  });
  cancel = vi.fn(async () => {});
  private changeHandlers: ChangeHandler[] = [];

  /** The SDK getter we must never touch. */
  get methods(): string[] {
    throw new Error("not implemented");
  }

  on(_event: string, handler: ChangeHandler): this {
    this.changeHandlers.push(handler);
    return this;
  }

  off(_event: string, handler: ChangeHandler): this {
    this.changeHandlers = this.changeHandlers.filter((h) => h !== handler);
    return this;
  }

  emit(): void {
    for (const handler of [...this.changeHandlers]) handler();
  }
}

function makeManager() {
  const handlers = new Map<string, (arg: unknown) => void>();
  const client = {
    on: (event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
      return client;
    },
    off: () => client,
    emitRequest: (request: FakeRequest) => handlers.get("crypto.verificationRequestReceived")?.(request),
  };
  // The manager only needs getDeviceVerificationStatus from the crypto api.
  const crypto = { getDeviceVerificationStatus: vi.fn(async () => null) };
  const notify = vi.fn();
  const manager = new VerificationManager(
    client as never,
    crypto as never,
    notify as never,
  );
  manager.start();
  return { manager, client, notify };
}

describe("VerificationManager", () => {
  it("accepts a self-verification request and starts SAS without reading request.methods", async () => {
    const { manager, client, notify } = makeManager();
    const request = new FakeRequest();
    request.initiatedByMe = true; // initiator: the bridge sends start itself

    client.emitRequest(request);
    // accept() and the follow-up SAS start both settle on the microtask queue.
    await vi.waitFor(() => expect(request.startVerification).toHaveBeenCalledWith("m.sas.v1"));

    expect(request.accept).toHaveBeenCalledTimes(1);
    const messages = notify.mock.calls.map(([message]) => String(message));
    expect(messages.some((m) => m.includes("not implemented"))).toBe(false);
    expect(messages.some((m) => m.includes("Could not accept verification"))).toBe(false);
    expect(manager.list()).toHaveLength(1);
  });

  it("does not send its own start as the responder (peer started the flow)", async () => {
    const { manager, client, notify } = makeManager();
    const request = new FakeRequest();
    request.initiatedByMe = false;

    client.emitRequest(request);
    await vi.waitFor(() => expect(request.accept).toHaveBeenCalled());

    // Wait for the request to settle, then assert we stayed passive.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request.startVerification).not.toHaveBeenCalled();

    // The peer's start arrives -> we adopt its verifier and stay in the flow.
    request.verifier = new FakeVerifier();
    request.phase = VerificationPhase.Started;
    request.emit();

    expect(request.startVerification).not.toHaveBeenCalled();
    expect(manager.list()).toHaveLength(1);
    // ...but we must still drive the adopted verifier, or the peer waits forever.
    expect(request.verifier?.verify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([m]) => String(m)).some((m) => m.includes("Could not start"))).toBe(false);
  });

  it("sends start itself when the bridge initiated the request", async () => {
    const { manager, client } = makeManager();
    const request = new FakeRequest();
    request.initiatedByMe = true;

    client.emitRequest(request);
    await vi.waitFor(() => expect(request.startVerification).toHaveBeenCalledWith("m.sas.v1"));
    await vi.waitFor(() => expect(request.verifier?.verify).toHaveBeenCalledTimes(1));
    expect(manager.list()).toHaveLength(1);
  });

  it("never starts SAS twice for the same request", async () => {
    const { manager, client } = makeManager();
    const request = new FakeRequest();
    request.initiatedByMe = true;

    client.emitRequest(request);
    await vi.waitFor(() => expect(request.startVerification).toHaveBeenCalled());
    request.phase = VerificationPhase.Started;
    request.emit();
    request.emit();

    expect(request.startVerification).toHaveBeenCalledTimes(1);
    expect(manager.list()).toHaveLength(1);
  });
});
