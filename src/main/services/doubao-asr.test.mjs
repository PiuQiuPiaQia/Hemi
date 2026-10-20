import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

import {
  createRecognitionOptions,
  createRecognitionPayload,
  DoubaoAsrSession,
  encodeAudioRequest,
  encodeFullRequest,
  parseServerFrame,
  protocolConstants,
} from './doubao-asr.mjs';

test('encodes the official full-client request layout', () => {
  const payload = { audio: { format: 'pcm' }, request: { model_name: 'bigmodel' } };
  const frame = encodeFullRequest(1, payload);

  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x11, 0x11, 0x00]);
  assert.equal(frame.readInt32BE(4), 1);
  assert.equal(frame.readUInt32BE(8), frame.length - 12);
  assert.deepEqual(JSON.parse(gunzipSync(frame.subarray(12)).toString('utf8')), payload);
});

test('encodes normal and final audio frames with signed sequences', () => {
  const pcm = Buffer.alloc(protocolConstants.AUDIO_CHUNK_BYTES, 7);
  const normal = encodeAudioRequest(8, pcm);
  const final = encodeAudioRequest(9, pcm, true);

  assert.deepEqual([...normal.subarray(0, 4)], [0x11, 0x21, 0x01, 0x00]);
  assert.equal(normal.readInt32BE(4), 8);
  assert.deepEqual(gunzipSync(normal.subarray(12)), pcm);

  assert.deepEqual([...final.subarray(0, 4)], [0x11, 0x23, 0x01, 0x00]);
  assert.equal(final.readInt32BE(4), -9);
  assert.deepEqual(gunzipSync(final.subarray(12)), pcm);
});

test('parses a gzip JSON final server response', () => {
  const payload = {
    audio_info: { duration: 1200 },
    result: {
      text: '你好。',
      utterances: [{ start_time: 0, end_time: 1000, text: '你好。', definite: true }],
    },
  };
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  const sequence = Buffer.alloc(4);
  sequence.writeInt32BE(-4);
  const frame = Buffer.concat([
    Buffer.from([0x11, 0x93, 0x11, 0x00]),
    sequence,
    size,
    body,
  ]);

  const parsed = parseServerFrame(frame);
  assert.equal(parsed.code, 0);
  assert.equal(parsed.isLastPackage, true);
  assert.equal(parsed.payloadSequence, -4);
  assert.deepEqual(parsed.payloadMessage, payload);
});

test('parses provider error frames without gzip', () => {
  const message = Buffer.from('invalid audio format', 'utf8');
  const code = Buffer.alloc(4);
  code.writeInt32BE(45000151);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(message.length);
  const frame = Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x00, 0x00]),
    code,
    size,
    message,
  ]);

  const parsed = parseServerFrame(frame);
  assert.equal(parsed.code, 45000151);
  assert.equal(parsed.payloadMessage, 'invalid audio format');
});

test('uses the 16 kHz PCM and second-pass settings required by the demo', () => {
  const payload = createRecognitionPayload();

  assert.deepEqual(payload.audio, {
    format: 'pcm',
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1,
  });
  assert.equal(payload.request.model_name, 'bigmodel');
  assert.equal(payload.request.enable_nonstream, true);
  assert.equal(payload.request.show_utterances, true);
  assert.equal(payload.request.result_type, 'full');
  assert.equal(payload.request.end_window_size, 800);
});

test('hold tolerates pauses with second-pass recognition; calls preserve their speaker policy', () => {
  const hold = createRecognitionPayload(createRecognitionOptions('hold', { primarySpeakerEnabled: true }));
  assert.equal(hold.request.end_window_size, 1500);
  assert.equal(hold.request.enable_nonstream, true);
  assert.equal(hold.request.enable_speaker_info, undefined, 'hold does not filter short utterances by speaker');

  for (const primarySpeakerEnabled of [false, true]) {
    const call = createRecognitionPayload(createRecognitionOptions('continuous', { primarySpeakerEnabled }));
    assert.equal(call.request.end_window_size, 800, 'calls keep the existing silence-gate tail budget');
    assert.equal(call.request.enable_nonstream, primarySpeakerEnabled);
    assert.equal(call.request.enable_speaker_info, primarySpeakerEnabled ? true : undefined);
  }
});

test('hold sends the new policy on the wire and flushes second-pass corrections before stop resolves', { timeout: 5000 }, async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const events = [];
  let request;
  let uploadedBytes = 0;
  let ready;
  const partialReceived = new Promise((resolve) => { ready = resolve; });
  server.on('connection', (socket) => {
    const respond = (utterances, last = false) => {
      const body = gzipSync(Buffer.from(JSON.stringify({ result: { utterances } })));
      const header = Buffer.alloc(12);
      header.set([0x11, last ? 0x93 : 0x91, 0x11, 0x00]);
      header.writeInt32BE(last ? -2 : 1, 4);
      header.writeUInt32BE(body.length, 8);
      socket.send(Buffer.concat([header, body]));
    };
    socket.on('message', (data) => {
      const type = data[1] >>> 4;
      const body = gunzipSync(data.subarray(12));
      if (type === protocolConstants.MESSAGE.FULL_CLIENT_REQUEST) {
        request = JSON.parse(body.toString('utf8'));
        return;
      }
      uploadedBytes += body.length;
      if (data[1] & 0x02) {
        respond([{ start_time: 0, text: '帮我找关于命理的 skill。', definite: true }], true);
      } else {
        respond([{ start_time: 0, text: '帮我找一命关云', definite: false }]);
        respond([{ start_time: 0, text: '帮我找一命关云。', definite: true }]);
      }
    });
  });
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: `ws://127.0.0.1:${server.address().port}`, resourceId: 'test' },
    (event) => {
      events.push(event);
      if (event.type === 'transcript.final') ready();
    },
    createRecognitionOptions('hold'),
  );
  await session.start();
  const pcm = Buffer.alloc(7000, 1);
  session.sendAudio(pcm);
  await partialReceived;
  assert.equal(request.request.end_window_size, 1500);
  assert.equal(request.request.enable_nonstream, true);
  assert.ok(events.some((event) => event.type === 'transcript.partial' && event.text), 'partial text is visible before release');
  assert.ok(!events.some((event) => event.type === 'session.ended'));
  await session.stop();
  assert.equal(uploadedBytes, pcm.length, 'release flushes the remaining audio without discarding it');
  const finals = events.filter((event) => event.type === 'transcript.final');
  assert.deepEqual(finals.map((event) => event.text), ['帮我找一命关云。', '帮我找关于命理的 skill。']);
  assert.equal(finals[0].utteranceId, finals[1].utteranceId, 'the revision replaces the same utterance');
  assert.equal(events.at(-1).type, 'session.ended');
  assert.ok(!events.some((event) => event.type === 'error'));
});

test('extracts the second-pass speaker id from additions as a number', () => {
  const events = [];
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: 'wss://example.test', resourceId: 'test' },
    (event) => events.push(event),
  );

  // 实测形状（2026-09-20 speaker-probe）：定稿分句的编号在 additions.speaker_id
  // （字符串数字，"0" 有效）；流式 partial 没有。
  session.emitTranscripts({
    result: {
      text: '你好我是Hemi',
      utterances: [
        {
          definite: true,
          text: '你好，我是 Hemi。',
          start_time: 0,
          end_time: 3000,
          additions: { source: 'two_pass', speaker_id: '0' },
        },
      ],
    },
  });

  const final = events.find((event) => event.type === 'transcript.final');
  assert.equal(final.speaker, 0); // 字符串 "0" → 数字 0（有效编号，不是未知）
});

test('extracts nonzero speaker ids and tolerates missing additions', () => {
  const events = [];
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: 'wss://example.test', resourceId: 'test' },
    (event) => events.push(event),
  );

  session.emitTranscripts({
    result: {
      utterances: [
        { definite: true, text: 'B 说的', start_time: 0, additions: { speaker_id: '3' } },
        { definite: true, text: '没有编号的', start_time: 4000 },
        { definite: true, text: '顶层字段', start_time: 8000, speaker: 7 },
      ],
    },
  });

  const finals = events.filter((event) => event.type === 'transcript.final');
  assert.deepEqual(finals.map((event) => event.speaker), [3, null, 7]);
});

test('keeps interim text fluid and emits each second-pass utterance once', () => {
  const events = [];
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: 'wss://example.test', resourceId: 'test' },
    (event) => events.push(event),
  );

  session.emitTranscripts({
    result: {
      text: '帮我查一下',
      utterances: [
        { start_time: 0, text: '帮我查一下', definite: false },
      ],
    },
  });
  session.emitTranscripts({
    result: {
      text: '帮我查一下这个商品。',
      utterances: [
        { start_time: 0, text: '帮我查一下这个商品。', definite: true },
      ],
    },
  });
  session.emitTranscripts({
    result: {
      text: '帮我查一下这个商品。',
      utterances: [
        { start_time: 0, text: '帮我查一下这个商品。', definite: true },
      ],
    },
  });

  assert.deepEqual(
    events.filter((event) => event.type === 'transcript.final'),
    [
      {
        type: 'transcript.final',
        text: '帮我查一下这个商品。',
        utteranceId: '0:0',
        definite: true,
        speaker: null,
      },
    ],
  );
  assert.equal(events[0].type, 'transcript.partial');
  assert.equal(events[0].text, '帮我查一下');
  assert.deepEqual(events[0].utterances, [{ text: '帮我查一下', utteranceId: '0:0' }]);
  assert.equal(events.at(-1).type, 'transcript.partial');
  assert.equal(events.at(-1).text, '');
  assert.deepEqual(events.at(-1).utterances, []);
});

test('preserves partial identities across corrected finals and aggregate results', () => {
  const events = [];
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: 'wss://example.test', resourceId: 'test' },
    (event) => events.push(event),
  );
  session.sessionPrefix = 'session:';
  session.emitTranscripts({ result: { utterances: [
    { start_time: 0, text: '今天天气怎么样了', definite: false },
    { start_time: 2000, text: '明天呢', definite: false },
  ] } });
  assert.deepEqual(events.at(-1).utterances, [
    { text: '今天天气怎么样了', utteranceId: 'session:0:0' },
    { text: '明天呢', utteranceId: 'session:0:2000' },
  ]);
  session.emitTranscripts({ result: { utterances: [
    { start_time: 0, text: '今天天气怎么样呢？', definite: true },
    { start_time: 2000, text: '明天呢', definite: false },
  ] } });
  assert.equal(events.at(-2).utteranceId, 'session:0:0');
  assert.deepEqual(events.at(-1).utterances, [{ text: '明天呢', utteranceId: 'session:0:2000' }]);
  session.emitTranscripts({ result: { utterances: [
    { start_time: 0, text: '今天天气怎么样了', definite: false },
  ] } });
  assert.equal(events.at(-1).text, '', 'finalized partial cannot resurrect');
});

test('top-level fallback text carries no invented identity or speaker', () => {
  const events = [];
  const session = new DoubaoAsrSession(
    { apiKey: 'test', endpoint: 'wss://example.test', resourceId: 'test' },
    (event) => events.push(event),
  );
  session.emitTranscripts({ result: { text: '只有临时文本' } });
  assert.deepEqual(events.at(-1).utterances, [{ text: '只有临时文本' }]);
  assert.equal(events.at(-1).speaker, null);
});
