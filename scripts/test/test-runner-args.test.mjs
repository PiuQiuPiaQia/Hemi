import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {testRunnerArgs, testRunnerExitCode} from '../lib/test-runner-args.mjs';
test('test runner preserves the complete file list and default Node concurrency', () => {
  const files = ['first.test.mjs', 'path with spaces/second.test.mjs'];
  assert.deepEqual(testRunnerArgs([], files), ['--test', ...files]);
  assert.deepEqual(testRunnerArgs(['--test-concurrency=1'], files), ['--test', '--test-concurrency=1', ...files]);
  assert.deepEqual(testRunnerArgs(['--test-concurrency=3'], files), ['--test', '--test-concurrency=3', ...files]);
  assert.deepEqual(files, ['first.test.mjs', 'path with spaces/second.test.mjs']);
});
test('test runner rejects invalid concurrency and unrelated flags', () => {
  for (const args of [['--test-concurrency=0'], ['--test-concurrency=-1'], ['--test-concurrency=1.5'], ['--test-concurrency=01'], ['--test-concurrency=NaN'], ['--test-concurrency=9007199254740992'], ['--test-name-pattern=skip'], ['--test-concurrency=1', '--test-concurrency=2']]) assert.throws(() => testRunnerArgs(args, []));
});
test('test runner does not swallow child failure or signal exit', () => {
  assert.equal(testRunnerExitCode({status: 0}), 0);
  assert.equal(testRunnerExitCode({status: 7}), 7);
  assert.equal(testRunnerExitCode({status: null, signal: 'SIGTERM'}), 1);
});
test('real runner rejects an invalid flag before spawning the full test suite', () => {
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--test-concurrency=0'], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /正整数/);
  assert.doesNotMatch(result.stdout, /TAP version/);
});
