import { describe, expect, it } from 'vitest';
import { CHAT_COMMANDS, chatCommandName, parseChatCommand } from '../src/chat-commands.js';

describe('parseChatCommand', () => {
  it('parses both prefixes and normalises the name', () => {
    expect(parseChatCommand('!reload')).toEqual({ name: 'reload', arg: '' });
    expect(parseChatCommand('/reload')).toEqual({ name: 'reload', arg: '' });
    expect(parseChatCommand('  !RELOAD  ')).toEqual({ name: 'reload', arg: '' });
    // People type "! reload" with a space; it must still be recognised.
    expect(parseChatCommand('! reload')).toEqual({ name: 'reload', arg: '' });
    expect(parseChatCommand('/  reload')).toEqual({ name: 'reload', arg: '' });
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

describe('chatCommandName', () => {
  it('accepts the bridge commands only', () => {
    expect(chatCommandName('!reload')).toBe('reload');
    expect(chatCommandName('/reload')).toBe('reload');
    expect(chatCommandName('!compact')).toBe('compact');
    expect(chatCommandName('/compact')).toBe('compact');
  });

  it('leaves everything else to the agent', () => {
    expect(chatCommandName('!help')).toBeNull(); // handled by the auth layer
    expect(chatCommandName('!verify start X')).toBeNull(); // handled by the transport
    expect(chatCommandName('reload')).toBeNull(); // no prefix: plain text
    expect(chatCommandName('!reboot')).toBeNull(); // not a command we own
  });

  it('documents what it handles', () => {
    expect(CHAT_COMMANDS).toContain('reload');
    expect(CHAT_COMMANDS).toContain('compact');
  });
});
