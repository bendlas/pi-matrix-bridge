import { describe, expect, it } from 'vitest';
import { CHAT_COMMANDS, chatCommand, parseChatCommand } from '../src/chat-commands.js';

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

describe('chatCommand', () => {
  it('accepts the bridge commands only', () => {
    expect(chatCommand('!reload')).toEqual({ name: 'reload', arg: '' });
    expect(chatCommand('/reload')).toEqual({ name: 'reload', arg: '' });
    expect(chatCommand('!compact')).toEqual({ name: 'compact', arg: '' });
    expect(chatCommand('/compact')).toEqual({ name: 'compact', arg: '' });
  });

  it('carries the argument for commands that take one', () => {
    expect(chatCommand('!steer stop editing tests, fix the parser')).toEqual({
      name: 'steer',
      arg: 'stop editing tests, fix the parser',
    });
    // Whitespace after the prefix, as people type it.
    expect(chatCommand('! steer  look at the lock file')).toEqual({
      name: 'steer',
      arg: 'look at the lock file',
    });
    // A trailing mention is stripped, not steered.
    expect(chatCommand('!steer hurry @frogbot:bendlas.net')).toEqual({
      name: 'steer',
      arg: 'hurry',
    });
  });

  it('leaves everything else to the agent', () => {
    expect(chatCommand('!help')).toBeNull(); // handled by the auth layer
    expect(chatCommand('!verify start X')).toBeNull(); // handled by the transport
    expect(chatCommand('reload')).toBeNull(); // no prefix: plain text
    expect(chatCommand('!reboot')).toBeNull(); // not a command we own
    expect(chatCommand('!steering wheel alignment')).toBeNull(); // not an exact name
  });

  it('documents what it handles', () => {
    expect(CHAT_COMMANDS).toContain('reload');
    expect(CHAT_COMMANDS).toContain('compact');
    expect(CHAT_COMMANDS).toContain('steer');
  });
});
