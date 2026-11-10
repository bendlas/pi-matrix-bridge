import { describe, expect, it } from 'vitest';
import {
  answerHint,
  buildAskOutcome,
  parseAskAnswers,
  renderAskAnswersText,
  type AskRequest,
} from '../src/ask.js';

const ask: AskRequest = {
  askId: 'ask-1',
  askedAt: '2026-11-10T20:00:00.000Z',
  questions: [
    {
      id: 'reached',
      question: 'Did it arrive?',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      id: 'routing',
      question: 'How should answers be routed?',
      options: [
        { value: 'plain', label: 'Plain reply' },
        { value: 'structured', label: 'Structured submit' },
        { value: 'both', label: 'Both' },
      ],
    },
    {
      id: 'tags',
      question: 'Which tags?',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
      multiple: true,
    },
  ],
};

describe('parseAskAnswers', () => {
  it('parses space-separated option letters', () => {
    expect(parseAskAnswers('1a 2c', ask)).toEqual([
      { id: 'reached', values: ['yes'] },
      { id: 'routing', values: ['both'] },
    ]);
  });

  it('parses several letters for a multi-select question', () => {
    expect(parseAskAnswers('3ac', ask)).toEqual([{ id: 'tags', values: ['a', 'c'] }]);
  });

  it('rejects several letters for a single-choice question', () => {
    expect(parseAskAnswers('1ab', ask)).toBeNull();
  });

  it('parses comments and free text', () => {
    expect(parseAskAnswers('1a ~ very helpful', ask)).toEqual([
      { id: 'reached', values: ['yes'], comment: 'very helpful' },
    ]);
    expect(parseAskAnswers('2: write it myself', ask)).toEqual([
      { id: 'routing', otherText: 'write it myself' },
    ]);
  });

  it('accepts question ids and newline/semicolon separators', () => {
    expect(parseAskAnswers('reached a; routing b', ask)).toEqual([
      { id: 'reached', values: ['yes'] },
      { id: 'routing', values: ['structured'] },
    ]);
    expect(parseAskAnswers('1a\n2b', ask)).toHaveLength(2);
  });

  it('keeps a comment that itself contains colons and questions', () => {
    // Real message from the first live test: prose with "2:" and "also:" inside
    // the comment must stay in the comment rather than start a new answer.
    const text =
      '1a ~ are we still on sas-verification, even with the ask tool? 2: is this free text? ' +
      'also: does the second colon confuse the parser?';
    expect(parseAskAnswers(text, ask)).toEqual([
      {
        id: 'reached',
        values: ['yes'],
        comment:
          'are we still on sas-verification, even with the ask tool? 2: is this free text? ' +
          'also: does the second colon confuse the parser?',
      },
    ]);
  });

  it('continues a comment over semicolons and newlines', () => {
    expect(parseAskAnswers('1a ~ note; with semicolon', ask)).toEqual([
      { id: 'reached', values: ['yes'], comment: 'note with semicolon' },
    ]);
    expect(parseAskAnswers('1a ~ first line\nsecond line of the note', ask)).toEqual([
      { id: 'reached', values: ['yes'], comment: 'first line second line of the note' },
    ]);
  });

  it('starts a new answer after a comment that ran over a line break', () => {
    // The failure that prompted this: an answer typed after a multi-line comment
    // used to be folded into the comment and leave its question unanswered.
    expect(parseAskAnswers('1a ~ a considered note\n2: free text', ask)).toEqual([
      { id: 'reached', values: ['yes'], comment: 'a considered note' },
      { id: 'routing', otherText: 'free text' },
    ]);
  });

  it('returns null for prose, so real messages are never swallowed', () => {
    expect(parseAskAnswers('do it 2 times please', ask)).toBeNull();
    expect(parseAskAnswers('ok, sounds good', ask)).toBeNull();
    expect(parseAskAnswers('1', ask)).toBeNull(); // a bare number is not an answer
    expect(parseAskAnswers('1z', ask)).toBeNull(); // option was never offered
    expect(parseAskAnswers('9a', ask)).toBeNull(); // no such question
    expect(parseAskAnswers('', ask)).toBeNull();
  });
});

describe('buildAskOutcome', () => {
  it('records answered, unanswered and the summary', () => {
    const outcome = buildAskOutcome(
      ask,
      [{ id: 'reached', values: ['yes'], comment: 'clear' }],
      '2026-11-10T20:01:00.000Z',
    );

    expect(outcome.answeredCount).toBe(1);
    expect(outcome.unansweredIds).toEqual(['routing', 'tags']);
    expect(outcome.summary).toBe('Answered 1 of 3; unanswered: routing, tags');
    expect(outcome.questions[0]).toMatchObject({ answered: true, values: ['yes'], comment: 'clear' });
    expect(outcome.questions[1]).toMatchObject({ answered: false, values: [] });
  });

  it('reports a fully answered set without an unanswered list', () => {
    const outcome = buildAskOutcome(
      ask,
      [
        { id: 'reached', values: ['yes'] },
        { id: 'routing', values: ['both'] },
        { id: 'tags', values: ['a', 'b'] },
      ],
      '2026-11-10T20:01:00.000Z',
    );
    expect(outcome.summary).toBe('Answered 3 of 3; none left unanswered');
  });

  it('renders the model-facing text like pi-web does', () => {
    const outcome = buildAskOutcome(
      ask,
      [{ id: 'reached', values: ['yes'], comment: 'clear' }, { id: 'routing', otherText: 'mine' }],
      '2026-11-10T20:01:00.000Z',
    );
    const text = renderAskAnswersText(outcome);

    expect(text).toContain('The user submitted answers to your questions.');
    expect(text).toContain('- reached: Did it arrive?');
    expect(text).toContain('  Answered: selected yes; comment: "clear"');
    expect(text).toContain('  Answered: custom: "mine"');
    expect(text).toContain('- tags: Which tags?');
    expect(text).toContain('  Unanswered.');
  });

  it('renders a skip as cancelled', () => {
    const outcome = buildAskOutcome(ask, [], '2026-11-10T20:01:00.000Z', 'cancelled');
    expect(renderAskAnswersText(outcome)).toContain('The user skipped these questions.');
    expect(outcome.answeredCount).toBe(0);
  });
});

describe('answerHint', () => {
  it('documents each form', () => {
    const hint = answerHint();
    expect(hint).toContain('1a 2c');
    expect(hint).toContain('~ my note');
    expect(hint).toContain('2: free text');
    expect(hint).toContain('/skip');
  });
});
