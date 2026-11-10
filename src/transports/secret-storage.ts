/**
 * Secret-storage access for cross-signing without SAS.
 *
 * Emoji verification needs both sides to agree on ephemeral keys *and* the peer
 * to have a current view of our device keys. When that fails (Element cancelling
 * with `m.mismatched_sas`), the owner can still cross-sign the bridge device
 * directly: the account's self-signing private key lives in secret storage, and
 * knowing the recovery key is exactly the authority that emoji verification
 * would have granted.
 *
 * The key is read from a file (mode 0600) instead of the chat transcript.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the user drops frogbot's recovery key (base58, Element's format). */
export const RECOVERY_KEY_PATH = path.join(os.homedir(), ".pi", "matrix-bridge-recovery-key");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode a base58 string (Element's recovery-key alphabet). Whitespace is
 * ignored, so the grouped `XXXX XXXX …` presentation can be pasted verbatim.
 */
export function base58Decode(input: string): Uint8Array<ArrayBuffer> {
  const text = input.replace(/\s+/g, "");
  if (!text) throw new Error("empty base58 input");

  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) throw new Error(`invalid base58 character ${JSON.stringify(char)}`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

/**
 * Read and decode the recovery key file, or null when it is absent/blank.
 * Accepts either base58 (Element) or 64 hex characters.
 */
export function readRecoveryKey(file = RECOVERY_KEY_PATH): Uint8Array<ArrayBuffer> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const text = raw.replace(/\s+/g, "");
  if (!text || text.startsWith("#")) return null;

  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    const bytes = new Uint8Array(new ArrayBuffer(32));
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return base58Decode(text);
}

/**
 * `ICreateClientOpts.cryptoCallbacks.getSecretStorageKey` implementation: hand
 * matrix-js-sdk the recovery key for whichever secret-storage key it asks about.
 */
export function getSecretStorageKey(
  opts: { keys: Record<string, unknown> },
  _name: string,
): Promise<[string, Uint8Array<ArrayBuffer>] | null> {
  const keyIds = Object.keys(opts.keys ?? {});
  const key = readRecoveryKey();
  if (!key || keyIds.length === 0) return Promise.resolve(null);
  // matrix-sdk validates the key against the stored MAC, so trying the first
  // id is safe: a wrong key fails loudly instead of corrupting anything.
  return Promise.resolve([keyIds[0], key]);
}
