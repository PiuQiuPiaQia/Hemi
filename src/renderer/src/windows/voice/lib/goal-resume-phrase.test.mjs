import assert from 'node:assert/strict';
import test from 'node:test';
import { GOAL_RESUME_PHRASES, isGoalResumePhrase } from './goal-resume-phrase.ts';

test('whitelist: exact phrases match after trim', () => {
  for (const phrase of GOAL_RESUME_PHRASES) {
    assert.equal(isGoalResumePhrase(phrase), true, phrase);
    assert.equal(isGoalResumePhrase(`  ${phrase}  `), true, phrase);
    assert.equal(isGoalResumePhrase(`${phrase}\n`), true, phrase);
  }
});

test('whitelist: near-miss text never matches (no fuzzy or substring match)', () => {
  const nearMiss = [
    '继续，但是换个思路',
    '继续，但换个思路',
    '继续上次',
    '请继续任务',
    '继续任务吧',
    '接着做吧',
    '帮我接着干',
    '继续。',
    '继续！',
    'continue',
    '繼續',
    '',
    '   ',
  ];
  for (const text of nearMiss) assert.equal(isGoalResumePhrase(text), false, text);
});

test('whitelist: matching is case- and width-strict, no prefix folding', () => {
  assert.equal(isGoalResumePhrase('继续 任务'), false);
  assert.equal(isGoalResumePhrase('继续任务 '), true);
  assert.equal(isGoalResumePhrase('接着干点别的'), false);
});
