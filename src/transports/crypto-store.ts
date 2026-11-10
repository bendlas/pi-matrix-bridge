/**
 * Persistent crypto store for matrix-js-sdk (Rust/WASM) in Node.
 *
 * matrix-js-sdk's Rust crypto implementation stores its state in IndexedDB and
 * only offers two backends in Node: a real IndexedDB (none exists) or an
 * in-memory store. An in-memory store would mint new device identity keys on
 * every restart — which silently un-verifies the bridge device — so we keep the
 * in-memory store (fake-indexeddb) alive for the process and snapshot it to a
 * single JSON file:
 *
 *   - restore before `initRustCrypto()` opens the store
 *   - dump periodically while running (and on disconnect)
 *
 * Dumps are crash-consistent: IndexedDB transactions are atomic, so a snapshot
 * taken between transactions is a valid (slightly older) store state, exactly
 * as if the process had been killed at that point.
 *
 * Note: this is our own layer, not an upstream API. If matrix-js-sdk ever ships
 * a Node crypto store, delete this file and switch to it.
 */

import "fake-indexeddb/auto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Snapshot format version. Bump when the shape below changes. */
const SNAPSHOT_VERSION = 1;

/** Prefix for this bridge's IndexedDB databases (also used to filter on restore). */
export const CRYPTO_DB_PREFIX = "pi-matrix-bridge";

/**
 * - `u8`  Uint8Array (base64)
 * - `ab`  ArrayBuffer / typed-array view (base64)
 * - `date` Date (ISO 8601)
 * - `obj` plain object (Map of serialized values)
 * Arrays and primitives are stored as-is.
 */
type SerializedValue =
  | string
  | number
  | boolean
  | null
  | SerializedValue[]
  | { $: "u8" | "ab"; v: string }
  | { $: "date"; v: string }
  | { $: "obj"; v: Record<string, SerializedValue> };

interface SerializedRecord {
  key: SerializedValue;
  value: SerializedValue;
}

interface SerializedIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface SerializedStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: SerializedIndex[];
  records: SerializedRecord[];
}

interface SerializedDatabase {
  name: string;
  version: number;
  stores: SerializedStore[];
}

interface CryptoStoreSnapshot {
  version: number;
  createdAt: string;
  databases: SerializedDatabase[];
}

/* -------------------------------------------------------------------------- */
/* value (de)serialization                                                    */
/* -------------------------------------------------------------------------- */

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function serializeValue(value: unknown): SerializedValue {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value as string | number | boolean;
  }
  if (value instanceof Uint8Array) return { $: "u8", v: toBase64(value) };
  if (value instanceof ArrayBuffer) {
    return { $: "ab", v: toBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      $: "ab",
      v: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }
  if (value instanceof Date) return { $: "date", v: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (type === "object") {
    const out: Record<string, SerializedValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return { $: "obj", v: out };
  }
  // BigInt/symbol/function never appear in the Rust crypto store.
  throw new Error(`Cannot snapshot crypto store value of type ${type}`);
}

function deserializeValue(value: SerializedValue): unknown {
  if (value === null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deserializeValue);
  switch (value.$) {
    case "u8":
      return fromBase64(value.v);
    case "ab":
      return fromBase64(value.v).buffer;
    case "date":
      return new Date(value.v);
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.v)) {
        out[k] = deserializeValue(v);
      }
      return out;
    }
    default:
      throw new Error(`Unknown snapshot value tag: ${(value as { $: string }).$}`);
  }
}

/* -------------------------------------------------------------------------- */
/* IndexedDB helpers                                                          */
/* -------------------------------------------------------------------------- */

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Could not open database ${name}`));
    req.onblocked = () => reject(new Error(`Opening database ${name} is blocked`));
  });
}

/** True if this database belongs to the bridge (name starts with our prefix). */
function isOurs(name: string): boolean {
  return name.startsWith(CRYPTO_DB_PREFIX);
}

/* -------------------------------------------------------------------------- */
/* snapshot / restore                                                         */
/* -------------------------------------------------------------------------- */

export async function captureCryptoStore(): Promise<CryptoStoreSnapshot> {
  const infos = await indexedDB.databases();
  const databases: SerializedDatabase[] = [];

  for (const info of infos) {
    const name = info.name;
    if (!name || !isOurs(name)) continue;

    const db = await openDatabase(name);
    try {
      const stores: SerializedStore[] = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const indexes: SerializedIndex[] = Array.from(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return {
            name: index.name,
            keyPath: index.keyPath as string | string[],
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        });
        const [keys, values] = await Promise.all([
          request(store.getAllKeys()),
          request(store.getAll()),
        ]);
        await transactionDone(tx);
        stores.push({
          name: storeName,
          keyPath: store.keyPath as string | string[] | null,
          autoIncrement: store.autoIncrement,
          indexes,
          records: keys.map((key, i) => ({
            key: serializeValue(key),
            value: serializeValue(values[i]),
          })),
        });
      }
      databases.push({ name: db.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    databases,
  };
}

/**
 * Restore a snapshot into the in-memory IndexedDB. Must run before
 * `initRustCrypto()`.
 *
 * Returns true if a snapshot was loaded. Throws if the file exists but is
 * unreadable — silently starting with an empty store would rotate the device
 * identity keys, which is worse than failing loudly.
 */
export async function restoreCryptoStore(snapshotPath: string): Promise<boolean> {
  if (!fs.existsSync(snapshotPath)) return false;
  const raw = fs.readFileSync(snapshotPath, "utf8");

  let snapshot: CryptoStoreSnapshot;
  try {
    snapshot = JSON.parse(raw) as CryptoStoreSnapshot;
  } catch (err) {
    throw new Error(
      `Crypto store snapshot ${snapshotPath} is not valid JSON (${(err as Error).message}). ` +
        "Delete the file to start with a fresh device (the bridge device will need re-verifying).",
    );
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `Crypto store snapshot ${snapshotPath} has unsupported format version ${snapshot.version}. ` +
        "Delete the file to start with a fresh device (the bridge device will need re-verifying).",
    );
  }

  for (const database of snapshot.databases) {
    // A database may already exist if restore runs twice in one process.
    if ((await indexedDB.databases()).some((d) => d.name === database.name)) continue;

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(database.name, database.version);
      req.onupgradeneeded = () => {
        const upgradeDb = req.result;
        for (const store of database.stores) {
          const objectStore = upgradeDb.createObjectStore(store.name, {
            keyPath: store.keyPath ?? undefined,
            autoIncrement: store.autoIncrement,
          });
          for (const index of store.indexes) {
            objectStore.createIndex(index.name, index.keyPath, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`Could not create ${database.name}`));
      req.onblocked = () => reject(new Error(`Creating ${database.name} is blocked`));
    });

    try {
      for (const store of database.stores) {
        if (store.records.length === 0) continue;
        const tx = db.transaction(store.name, "readwrite");
        const objectStore = tx.objectStore(store.name);
        for (const record of store.records) {
          const value = deserializeValue(record.value);
          const key = deserializeValue(record.key);
          if (store.keyPath != null || store.autoIncrement) {
            objectStore.put(value);
          } else if (key !== null) {
            objectStore.put(value, key as IDBValidKey);
          } else {
            objectStore.add(value);
          }
        }
        await transactionDone(tx);
      }
    } finally {
      db.close();
    }
  }

  return true;
}

/** Atomically write a snapshot to disk (mode 0600 — it contains room keys). */
function writeCryptoStore(snapshotPath: string, snapshot: CryptoStoreSnapshot): void {
  const tmpPath = `${snapshotPath}.tmp`;
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(tmpPath, snapshotPath);
}

/**
 * Debounced snapshot writer. `schedule()` is cheap and may be called on every
 * sync; an actual capture happens at most once per `delayMs`, plus a trailing
 * capture so the last change is never lost.
 */
export class CryptoStoreSnapshotter {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private dirty = false;
  private stopped = false;
  private lastError?: Error;

  constructor(
    private readonly snapshotPath: string,
    private readonly delayMs = 5000,
    private readonly onError?: (err: Error) => void,
  ) {}

  /** Mark the store dirty; capture after the debounce window. */
  schedule(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Capture immediately (if dirty). Never throws. */
  async flush(): Promise<void> {
    if (this.stopped || this.running || !this.dirty) return;
    this.running = true;
    this.dirty = false;
    try {
      const snapshot = await captureCryptoStore();
      writeCryptoStore(this.snapshotPath, snapshot);
      this.lastError = undefined;
    } catch (err) {
      this.dirty = true; // retry on the next schedule
      this.lastError = err as Error;
      this.onError?.(err as Error);
    } finally {
      this.running = false;
      // Changes that arrived while capturing are picked up by a trailing flush.
      if (this.dirty && !this.timer && !this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, this.delayMs);
        this.timer.unref?.();
      }
    }
  }

  /** Final flush and stop scheduling. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Wait for an in-flight capture (bounded, so a stuck IndexedDB can't hang
    // shutdown) before the final flush, otherwise the last changes are dropped.
    const deadline = Date.now() + 5000;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.flush();
    this.stopped = true;
  }

  /** Most recent write error, if the last capture failed. */
  get error(): Error | undefined {
    return this.lastError;
  }
}
