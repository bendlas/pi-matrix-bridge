import { describe, expect, it } from "vitest";
import { base58Decode, readRecoveryKey } from "../src/transports/secret-storage.js";

describe("base58Decode", () => {
  // Vectors from Bitcoin Core's base58_encode_decode.json.
  const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  it("decodes the canonical vectors", () => {
    expect(hex(base58Decode("2g"))).toBe("61");
    expect(hex(base58Decode("a3gV"))).toBe("626262");
    expect(hex(base58Decode("aPEr"))).toBe("636363");
    expect(hex(base58Decode("2cFupjhnEsSn59qHXstmK2ffpLv2"))).toBe(
      "73696d706c792061206c6f6e6720737472696e67",
    );
    expect([...base58Decode("1")]).toEqual([0]);
  });

  it("ignores the grouped presentation Element shows", () => {
    expect(hex(base58Decode("a3g V"))).toBe("626262");
    expect(hex(base58Decode("2cFu pjhn EsSn 59qH Xstm K2ff pLv2"))).toBe(
      "73696d706c792061206c6f6e6720737472696e67",
    );
  });

  it("rejects characters outside the alphabet and empty input", () => {
    expect(() => base58Decode("0OIl")).toThrow(/invalid base58/);
    // An empty file must not be treated as a valid key.
    expect(() => base58Decode("")).toThrow(/empty base58/);
  });

  it("decodes a 32-byte key to 32 bytes", () => {
    // 32 zero bytes -> 32 '1's
    const key = base58Decode("1".repeat(32));
    expect(key).toHaveLength(32);
    expect([...key].every((b) => b === 0)).toBe(true);
  });

  it("returns null when the key file is missing", () => {
    expect(readRecoveryKey("/nonexistent/recovery-key")).toBeNull();
  });
});
