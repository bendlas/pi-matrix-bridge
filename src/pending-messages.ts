/**
 * A FIFO for inbound chat messages that cannot be delivered yet.
 *
 * The one case that needs it: pi refuses a prompt while compaction is running
 * (`prompt()` throws before it even looks at `deliverAs`), so a chat message
 * that arrives mid-compaction has nowhere to go. Dropping it silently — which
 * is what an un-awaited `sendUserMessage()` rejection amounts to — loses the
 * user's instruction, so hold it instead and replay in arrival order.
 */
export interface PendingMessages<T> {
  /** Queue a message for later delivery. */
  push: (message: T) => void;
  /** Remove and return everything queued, in arrival order. */
  drain: () => T[];
  /** Number of queued messages. */
  size: () => number;
}

export function createPendingMessages<T>(): PendingMessages<T> {
  let queue: T[] = [];

  return {
    push(message: T): void {
      queue.push(message);
    },
    drain(): T[] {
      // Swap first: a flush may itself enqueue (a re-queue after a failed
      // delivery), and that must land in the new queue rather than be replayed
      // forever in this one.
      const drained = queue;
      queue = [];
      return drained;
    },
    size(): number {
      return queue.length;
    },
  };
}
