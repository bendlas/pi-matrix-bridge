/**
 * When a chat message cannot be handed to the agent right now.
 *
 * pi's `deliverAs: "followUp"` is not an option for chat messages: the
 * follow-up turn starts *after* `turn_end`, which is where the previous turn's
 * reply is sent and the routing to the originating chat is cleared. The
 * follow-up turn therefore has no destination and its answer is lost. The
 * bridge queues such messages itself and delivers them once the agent has
 * settled, which sets the routing at the moment of delivery instead.
 */
export type QueueReason = "compaction" | "busy" | null;

export function queueReason(idle: boolean, compacting: boolean): QueueReason {
  // Compaction wins: pi refuses prompts outright while it runs.
  if (compacting) return "compaction";
  if (!idle) return "busy";
  return null;
}
