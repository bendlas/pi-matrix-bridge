/**
 * Chat-side commands.
 *
 * Matrix has no command protocol: Element only knows its own client commands and
 * sends anything else as an ordinary message, which is why a typed `/reload`
 * used to arrive as prose. The community convention is a `!command` prefix; this
 * bridge already accepts both prefixes for admin commands, so a chat command is
 * simply a message to a *trusted* user in a DM that names one of the commands
 * below. Everything else still reaches the agent as text.
 */

/** Commands the bridge acts on itself instead of forwarding them. */
export const CHAT_COMMANDS = ["reload", "compact", "steer"] as const;

/** A parsed `!name arg…` message. */
export interface ChatCommand {
  name: string;
  arg: string;
}

/**
 * Parse a message into a command, or null when it is prose.
 *
 * The name is normalised to lowercase and may be prefixed with `/` or `!`.
 * A trailing `@bot:server` mention (as Element inserts for a mentioned user) is
 * stripped, so `!reload @frogbot:bendlas.net` works after a mention.
 */
export function parseChatCommand(text: string): ChatCommand | null {
  const trimmed = text.trim().replace(/\s+@[^\s@:]*(?::[^\s@:]*)?$/, "");
  // Whitespace after the prefix is tolerated: "! reload" is what people type.
  const match = /^[/!]\s*([a-zA-Z][a-zA-Z0-9_-]{0,31})(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

/**
 * The bridge command a message names, with its argument, or null when the
 * message is for the agent.
 *
 * Only names listed in CHAT_COMMANDS are intercepted: any other `/` or `!` text
 * is ordinary conversation and must reach the model.
 */
export function chatCommand(
  text: string
): { name: (typeof CHAT_COMMANDS)[number]; arg: string } | null {
  const command = parseChatCommand(text);
  if (!command) return null;
  const known = CHAT_COMMANDS.find((name) => name === command.name);
  return known ? { name: known, arg: command.arg } : null;
}
