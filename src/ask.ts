/**
 * Answering `ask_user` question sets from chat.
 *
 * `ask_user` (pi-web) posts a browser form, ends the run, and later delivers a
 * follow-up message holding the answers. Nothing about that is Matrix-specific:
 * delivering the same custom message from here gives the agent — and the web UI,
 * which reads the transcript — the identical outcome.
 *
 * The parser is deliberately strict. A chat message is usually prose, so a loose
 * "looks like an answer" test would swallow real instructions ("do it 2 times").
 * A message is treated as an answer only when *every* segment parses.
 */

/** An option of an asked question. */
export interface AskOption {
  value: string;
  label: string;
  detail?: string;
}

/** One asked question, as pi-web persists it in the tool result. */
export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  options: AskOption[];
  multiple?: boolean;
}

/** A posted question set. */
export interface AskRequest {
  askId: string;
  askedAt: string;
  questions: AskQuestion[];
}

/** One answered question, matching pi-web's persisted outcome shape. */
export interface AskAnswer {
  id: string;
  /** Selected option values; absent for a custom-text answer. */
  values?: string[];
  otherText?: string;
  comment?: string;
}

/** An answered question inside an outcome. */
interface OutcomeQuestion {
  question: AskQuestion;
  answered: boolean;
  values: string[];
  otherText?: string;
  comment?: string;
}

/** The outcome pi-web records for a submitted answer set. */
export interface AskOutcome {
  askId: string;
  reason: "submitted" | "cancelled";
  askedAt: string;
  closedAt: string;
  questions: OutcomeQuestion[];
  answeredCount: number;
  unansweredIds: string[];
  summary: string;
}

/** Pure option tokens, e.g. "1a 2bc" — no prose, so no false positives. */
const BARE_TOKENS = /^\s*(?:\d+[a-z]*|\d+[a-z]*.*)$/;

/** `3`, `3b`, `3bc`, `3a ~ a note`, `3: free text`. */
const SEGMENT = /^(\d+|[a-z][\w-]*)\s*[:.)-]?\s*([a-z]{1,12})?\s*(?:~\s*([\s\S]*))?$/i;
/** `<n>: free text` / `<n>. free text` / `<n>- free text`. */
const FREE_TEXT = /^(\d+|[a-z][\w-]*)\s*[:.)-]\s*(\S[\s\S]*)$/;

/** Split an answer message into segments, or null when it is prose. */
function segments(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // "1a 2c" — only bare question tokens, so splitting on whitespace is safe.
  if (/^\s*\d+[a-z]*(?:\s+\d+[a-z]*)+$/i.test(trimmed)) {
    return trimmed.split(/\s+/);
  }

  const parts = trimmed
    .split(/[\n;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  // Every segment must look like an answer; one prose segment means this is a
  // message, not an answer.
  return parts.every((part) => SEGMENT.test(part) || FREE_TEXT.test(part)) ? parts : null;
}

/** Resolve a `1` or a question id to its question. */
function findQuestion(questions: AskQuestion[], key: string): AskQuestion | undefined {
  const trimmed = key.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    return questions[index];
  }
  return questions.find((q) => q.id === trimmed || q.id.toLowerCase() === trimmed.toLowerCase());
}

/** Map letters to option values, rejecting letters the question never offered. */
function optionValues(question: AskQuestion, letters: string): string[] | null {
  const values: string[] = [];
  for (const letter of letters.toLowerCase()) {
    const option = question.options[letter.charCodeAt(0) - 97];
    if (!option) return null;
    if (!values.includes(option.value)) values.push(option.value);
  }
  return values.length ? values : null;
}

/**
 * Parse an answer message against a question set.
 *
 * Returns null when the text is not an answer — prose, an unknown question, an
 * option that was never offered, or several answers for a single-choice
 * question. Callers then fall back to forwarding the text as a normal message,
 * so nothing is ever silently swallowed.
 */
export function parseAskAnswers(text: string, ask: AskRequest): AskAnswer[] | null {
  const parts = segments(text);
  if (!parts) return null;

  const answers = new Map<string, AskAnswer>();
  for (const part of parts) {
    const free = FREE_TEXT.exec(part);
    const typed = SEGMENT.exec(part);

    const key = free?.[1] ?? typed?.[1];
    if (!key) return null;
    const question = findQuestion(ask.questions, key);
    if (!question) return null;

    const existing: AskAnswer = answers.get(question.id) ?? { id: question.id };

    if (free && !typed?.[2]) {
      // `<n>: free text` answers with custom text.
      const otherText = free[2].trim();
      if (!otherText) return null;
      existing.otherText = otherText;
    } else {
      const letters = typed?.[2];
      if (!letters) return null; // a bare number is not an answer
      const values = optionValues(question, letters);
      if (!values) return null;
      if (question.multiple !== true && values.length > 1) return null;
      if (existing.values || existing.otherText !== undefined) return null;
      existing.values = values;
    }

    const comment = typed?.[3]?.trim();
    if (comment) existing.comment = comment;
    answers.set(question.id, existing);
  }

  return answers.size > 0 ? [...answers.values()] : null;
}

/** Build the outcome pi-web would have built for the same submission. */
export function buildAskOutcome(
  ask: AskRequest,
  answers: AskAnswer[],
  closedAt: string,
  reason: AskOutcome["reason"] = "submitted",
): AskOutcome {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const questions: OutcomeQuestion[] = ask.questions.map((question) => {
    const answer = byId.get(question.id);
    const values = answer?.values ?? [];
    const otherText = answer?.otherText;
    const comment = answer?.comment;
    const answered = values.length > 0 || otherText !== undefined;
    return {
      question: { ...question, options: question.options.map((option) => ({ ...option })) },
      answered,
      values: [...values],
      ...(otherText === undefined ? {} : { otherText }),
      ...(comment === undefined ? {} : { comment }),
    };
  });

  const unansweredIds = questions.filter((q) => !q.answered).map((q) => q.question.id);
  const answeredCount = questions.length - unansweredIds.length;
  return {
    askId: ask.askId,
    reason,
    askedAt: ask.askedAt,
    closedAt,
    questions,
    answeredCount,
    unansweredIds,
    summary:
      unansweredIds.length === 0
        ? `Answered ${answeredCount} of ${questions.length}; none left unanswered`
        : `Answered ${answeredCount} of ${questions.length}; unanswered: ${unansweredIds.join(", ")}`,
  };
}

/** The model-facing text for an outcome (same shape pi-web renders). */
export function renderAskAnswersText(outcome: AskOutcome): string {
  const lead =
    outcome.reason === "cancelled"
      ? "The user skipped these questions."
      : "The user submitted answers to your questions.";
  const lines = [lead, ""];
  for (const record of outcome.questions) {
    lines.push(`- ${record.question.id}: ${record.question.question}`);
    if (!record.answered) {
      lines.push("  Unanswered.");
      continue;
    }
    const parts = record.values.map((value) => `selected ${value}`);
    if (record.otherText !== undefined) parts.push(`custom: ${JSON.stringify(record.otherText)}`);
    if (record.comment !== undefined) parts.push(`comment: ${JSON.stringify(record.comment)}`);
    lines.push(`  Answered: ${parts.join("; ")}`);
  }
  lines.push("", outcome.summary);
  return lines.join("\n");
}

/** Hint shown under a mirrored question set, so the syntax is discoverable. */
export function answerHint(): string {
  return [
    "Answer with option letters and the question number:",
    '  • "1a 2c"  — options a and c',
    '  • "1a ~ my note"  — option a plus a comment',
    '  • "2: free text"  — custom answer instead of an option',
    '  • "/skip"  — skip the whole set, or just reply with prose',
  ].join("\n");
}
