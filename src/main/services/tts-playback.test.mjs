import assert from 'node:assert/strict';
import test from 'node:test';
import { TtsPlayback } from './tts-playback.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(resolveConfig = async () => ({ apiKey: 'test' })) {
  const sessions = [], events = [];
  const playback = new TtsPlayback({
    resolveConfig,
    createSession: (_config, emit) => {
      const ready = deferred();
      const session = {
        ready, emit, closed: false, spoken: [],
        start: () => ready.promise,
        speak(text) { this.spoken.push(text); },
        close() { this.closed = true; emit({ type: 'error', message: 'closed' }); },
      };
      sessions.push(session);
      return session;
    },
    emit: (turnId, event) => events.push({ turnId, ...event }),
  });
  return { playback, sessions, events };
}

test('a started synthesis remains cancellable and cannot emit audio afterwards', async () => {
  const { playback, sessions, events } = harness();
  const pending = playback.speak(1, '你好');
  await Promise.resolve();
  sessions[0].ready.resolve();
  assert.equal((await pending).ok, true);
  sessions[0].emit({ type: 'started' });
  sessions[0].emit({ type: 'audio', data: Buffer.from([1, 2]) });
  playback.cancel(1);
  sessions[0].emit({ type: 'audio', data: Buffer.from([3, 4]) });
  assert.equal(sessions[0].closed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
});

test('late failure from a replaced handshake does not cancel the new speech', async () => {
  const { playback, sessions, events } = harness();
  const first = playback.speak(-7, '阶段摘要');
  await Promise.resolve();
  const second = playback.speak(-8, '完整结果');
  await Promise.resolve();
  sessions[1].ready.resolve();
  assert.equal((await second).ok, true);
  sessions[1].emit({ type: 'started' });
  sessions[0].ready.reject(new Error('closed before connection established'));
  assert.equal((await first).ok, false);
  sessions[0].emit({ type: 'finished' });
  sessions[1].emit({ type: 'audio', data: Buffer.alloc(2) });
  sessions[1].emit({ type: 'finished' });
  assert.deepEqual(events.map(({ turnId, type }) => [turnId, type]), [[-8, 'audio'], [-8, 'finished']]);
  assert.deepEqual(sessions[0].spoken, []);
});

test('cancellation during config lookup prevents a connection from starting', async () => {
  const config = deferred();
  const { playback, sessions } = harness(() => config.promise);
  const pending = playback.speak(1, '你好');
  playback.cancel(1);
  config.resolve({ apiKey: 'test' });
  assert.equal((await pending).ok, false);
  assert.equal(sessions.length, 0);
});

test('overlapping config lookups cannot reorder the requested speeches', async () => {
  const config = deferred();
  let calls = 0;
  const { playback, sessions } = harness(() => ++calls === 1 ? config.promise : { apiKey: 'test' });
  const first = playback.speak(1, '旧的');
  const second = playback.speak(2, '新的');
  await Promise.resolve();
  sessions[0].ready.resolve();
  assert.equal((await second).ok, true);
  config.resolve({ apiKey: 'test' });
  assert.equal((await first).ok, false);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].spoken, ['新的']);
});
