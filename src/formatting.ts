import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Extract text from assistant message.
 */
export function extractTextFromMessage(message: AssistantMessage): string {
  const textParts = message.content.filter((part) => part.type === "text");
  return textParts.map((part: any) => part.text).join("\n");
}

/**
 * Extract the model's reasoning (thinking) text from an assistant message.
 * Returns "" when there is none (or it was redacted to an empty block).
 */
export function extractThinkingFromMessage(message: AssistantMessage): string {
  const thinkingParts = message.content.filter((part) => part.type === "thinking");
  return thinkingParts
    .map((part: any) => part.thinking ?? "")
    .join("\n")
    .trim();
}

/**
 * Render reasoning as a Matrix spoiler (`||…||` → `<span data-mx-spoiler>`),
 * collapsed in Element until tapped, so long reasoning doesn't bury the answer.
 */
export function formatThinking(thinking: string): string {
  const trimmed = thinking.trim();
  if (!trimmed) return "";
  // Split any `||` in the reasoning (e.g. a JS `a || b`) with a zero-width
  // space so it can't terminate the wrapping spoiler early.
  const body = trimmed.replace(/\|\|/g, "|\u200b|");
  return `💭 ||${body}||`;
}

/**
 * Check if assistant message contains tool calls (more turns will follow).
 */
export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

/**
 * Format a single tool-call summary line for the remote user.
 * Wraps the tool name in backticks so Matrix renders it as inline code,
 * preserving snake_case readability.
 */
export function formatToolCall(name: string, args: Record<string, unknown> | undefined): string {
  const toolName = name || "tool";

  // ask_user arguments are whole question sets; the rendered form is posted
  // separately, so a JSON blob here would just be noise.
  if (toolName === "ask_user") {
    const count = Array.isArray(args?.questions) ? args.questions.length : 0;
    return `🔧 \`ask_user\` (${count} question${count === 1 ? "" : "s"})`;
  }

  const argPairs = Object.entries(args || {})
    .map(([k, v]) => {
      const valStr = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${truncate(valStr, 50)}`;
    })
    .join(", ");

  return argPairs ? `🔧 \`${toolName}\` (${argPairs})` : `🔧 \`${toolName}\``;
}

/**
 * Format tool call summaries for the remote user.
 */
export function formatToolCalls(message: AssistantMessage): string {
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  if (toolCalls.length === 0) return "";
  return toolCalls
    .map((tc: any) => formatToolCall(tc.name, tc.arguments))
    .join("\n");
}

/**
 * Extract text from a tool result (AgentToolResult-shaped, or a plain string).
 */
export function extractToolResultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Wrap text in a fenced code block. The fence grows past any backtick run in
 * the text, so output that itself contains ``` fences stays literal.
 */
export function fencedCode(text: string, language = ""): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * Format a tool's output, shown (truncated) under its call line.
 * Multi-line output becomes a fenced code block so indentation, diffs and any
 * markdown-ish characters in the output stay literal on Matrix.
 * Returns "" when there's nothing to show and it wasn't an error.
 */
export function formatToolResult(result: any, isError: boolean): string {
  const text = extractToolResultText(result).trim();
  if (!text) return isError ? "↳ ⚠️ (error)" : "";
  const marker = isError ? "↳ ⚠️" : "↳";
  const shown = truncate(text, 1500);
  return shown.includes("\n") ? `${marker}\n${fencedCode(shown)}` : `${marker} ${shown}`;
}

/** One option of an ask_user question. */
export interface AskQuestionOption {
  value: string;
  label: string;
  detail?: string;
}

/** One question of an ask_user request. */
export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  options?: AskQuestionOption[];
  multiple?: boolean;
}

/**
 * Render an ask_user request for the chat, so a question posted as a browser
 * form is also answerable from Matrix.
 *
 * Options get letter keys (`a`, `b`, …) so a reply like "1a 2 yes" is
 * unambiguous, and the option *value* is shown only when it differs from the
 * label — the model sees values, the user reads labels.
 */
export function formatAskQuestions(ask: { questions: AskQuestion[] }): string {
  const questions = ask.questions ?? [];
  const count = questions.length;
  const lines: string[] = [
    `❓ ${count} question${count === 1 ? "" : "s"} — answer here in this chat`,
    "",
  ];

  questions.forEach((q, i) => {
    const many = q.multiple ? "  (pick several)" : "";
    lines.push(`${i + 1}) ${q.question}${many}`);
    if (q.detail) lines.push(`   ${q.detail}`);
    (q.options ?? []).forEach((option, j) => {
      const key = String.fromCharCode(97 + j);
      const value = option.value === option.label ? "" : ` [${option.value}]`;
      const detail = option.detail ? ` — ${option.detail}` : "";
      lines.push(`   ${key}) ${option.label}${value}${detail}`);
    });
    if (!(q.options ?? []).length) lines.push("   (free text)");
  });

  return lines.join("\n");
}

/**
 * Truncate string to max length with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Split long messages into chunks, breaking at newlines when possible.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) {
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt < maxLen * 0.3) {
      breakAt = maxLen;
    }

    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }

  return chunks;
}
