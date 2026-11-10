import { describe, expect, it } from 'vitest';
import { createPendingMessages } from '../src/pending-messages.js';

describe('createPendingMessages', () => {
  it('starts empty', () => {
    expect(createPendingMessages<string>().size()).toBe(0);
  });

  it('replays in arrival order', () => {
    const queue = createPendingMessages<string>();
    queue.push('first');
    queue.push('second');
    queue.push('third');
    expect(queue.drain()).toEqual(['first', 'second', 'third']);
  });

  it('is empty after draining', () => {
    const queue = createPendingMessages<string>();
    queue.push('only');
    queue.drain();
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('keeps messages pushed during a drain', () => {
    const queue = createPendingMessages<string>();
    queue.push('before');
    const first = queue.drain();
    // A failed delivery re-queues while the drain is still being processed.
    queue.push('during');
    expect(first).toEqual(['before']);
    expect(queue.drain()).toEqual(['during']);
  });
});
