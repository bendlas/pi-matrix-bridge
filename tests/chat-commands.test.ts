import { describe, expect, it } from 'vitest';
import { CHAT_COMMANDS, isReloadCommand, parseChatCommand } from '../src/chat-commands.js';

describe('parseChatCommand', () => {
  it('parses both prefixes and normalises the name', () => {
    expect(parseChatCommand('!reload')).toEqual({ name: 'reload', arg: '' });
    expect(parseChatCommand('/reload')).toEqual({ name: 'reload', arg: '' });
    expect(parseChatCommand('  !RELOAD  ')).toEqual({ name: 'reload', arg: '' });
  });

  it('keeps the rest of the line as arguments', () => {
    expect(parseChatCommand('!verify start CONTOXFROGBOT')).toEqual({
      name: 'verify',
      arg: 'start CONTOXFROGBOT',
    });
  });

  it('strips a trailing user mention', () => {
    expect(parseChatCommand('!reload @frogbot:bendlas.net')).toEqual({ name: 'reload', arg: '' });
  });

  it('returns null for prose and for slash commands that are only paths', () => {
    expect(parseChatCommand('reload please')).toBeNull();
    expect(parseChatCommand('/usr/bin/reload')).toBeNull(); // the `/` is inside a word
    expect(parseChatCommand('have a nice day')).toBeNull();
    expect(parseChatCommand('')).toBeNull();
  });
});

describe('isReloadCommand', () => {
  it('accepts the bridge commands only', () => {
    expect(isReloadCommand('!reload')).toBe(true);
    expect(isReloadCommand('/reload')).toBe(true);
    expect(isReloadCommand('!help')).toBe(false);
    expect(isReloadCommand('reload')).toBe(false);
  });

  it('documents what it handles', () => {
    expect(CHAT_COMMANDS).toContain('reload');
  });
});
