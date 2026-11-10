import { describe, expect, it } from 'vitest';
import { queueReason } from '../src/delivery.js';

describe('queueReason', () => {
  it('delivers when the agent is idle and nothing is compacting', () => {
    expect(queueReason(true, false)).toBeNull();
  });

  it('queues while a turn is running', () => {
    expect(queueReason(false, false)).toBe('busy');
  });

  it('queues while compacting, even though pi reports idle in between', () => {
    expect(queueReason(false, true)).toBe('compaction');
    expect(queueReason(true, true)).toBe('compaction');
  });
});
