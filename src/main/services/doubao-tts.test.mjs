import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  API_SUCCESS_CODE,
  EVENT,
  DEFAULT_TTS_SAMPLE_RATE,
  DoubaoTtsSession,
  createSessionPayload,
  createTaskPayload,
  describeTtsStatus,
  encodeClientFrame,
  parseServerFrame,
} from './doubao-tts.mjs';

function int32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** 造一帧服务端响应（与 doubao-asr.test.mjs 的帧构造器同思路）。 */
function serverFrame({
  messageType,
  flags = 0x4,
  serialization = 0x0,
  compression = 0x0,
  event = 0,
  payload = Buffer.alloc(0),
  code = 0,
  responseId = null,
}) {
  const parts = [
    Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]),
  ];
  if (messageType === 0xf) {
    // 错误帧不带事件号：紧跟错误码 + 负载。
    parts.push(int32(code), uint32(payload.length), payload);
    return Buffer.concat(parts);
  }
  if (flags & 0x4) parts.push(int32(event));
  if (responseId !== null) {
    parts.push(uint32(responseId.length), responseId);
  }
  parts.push(uint32(payload.length), payload);
  return Buffer.concat(parts);
}

const MESSAGE_TYPES = { FULL: 0x9, AUDIO: 0xb, ERROR: 0xf };

test('compressed audio is decoded before being forwarded as PCM', () => {
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const frame = serverFrame({ messageType: MESSAGE_TYPES.AUDIO, event: EVENT.TTSResponse, compression: 1, payload: gzipSync(pcm) });
  assert.deepEqual(parseServerFrame(frame).audio, pcm);
});

/** 记录 send 的假 socket；serverFrame() 用于向会话注入服务端帧。 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;

  constructor(endpoint, options) {
    FakeWebSocket.instances.push(this);
    this.endpoint = endpoint;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.handlers = {};
    this.sent = [];
    this.closeArgs = null;
  }

  on(event, handler) {
    (this.handlers[event] ??= []).push(handler);
  }

  once(event, handler) {
    this.on(event, handler);
  }

  off(event, handler) {
    this.handlers[event] = (this.handlers[event] ?? []).filter(
      (item) => item !== handler,
    );
  }

  emit(event, ...args) {
    for (const handler of [...(this.handlers[event] ?? [])]) handler(...args);
  }

  send(frame) {
    this.sent.push(Buffer.from(frame));
  }

  close(code, reason) {
    this.closeArgs = { code, reason };
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  terminate() {
    this.emit('close', 1006, Buffer.alloc(0));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  serverSend(buffer) {
    this.emit('message', buffer, true);
  }

  sentEvents() {
    return this.sent.map((frame) => {
      const headerSize = (frame[0] & 0x0f) * 4;
      let offset = headerSize;
      const event = frame.readInt32BE(offset);
      offset += 4;
      let sessionId = '';
      // 与真实解析器同一套容错：首段长度等于剩余字节时没有 session id,
      // 首段就是负载本身;否则首段是 session id,后面还有一个负载长度。
      const firstLength = frame.readUInt32BE(offset);
      offset += 4;
      let payload;
      if (firstLength === frame.length - offset) {
        payload = JSON.parse(frame.subarray(offset).toString('utf8'));
      } else {
        sessionId = frame.subarray(offset, offset + firstLength).toString('utf8');
        offset += firstLength;
        const payloadLength = frame.readUInt32BE(offset);
        payload = JSON.parse(
          frame.subarray(offset + 4, offset + 4 + payloadLength).toString('utf8'),
        );
      }
      return { event, sessionId, payload };
    });
  }
}
FakeWebSocket.instances = [];

function lastInstance() {
  return FakeWebSocket.instances.at(-1);
}

const TTS_CONFIG = {
  apiKey: 'test-key',
  resourceId: 'seed-tts-1.0',
  endpoint: 'wss://tts.example/api/v3/tts/bidirection',
  voice: 'zh_female_cancan_mars_bigtts',
  sampleRate: DEFAULT_TTS_SAMPLE_RATE,
  speechRate: 0,
};

test('encodes the bidirectional client frame layout', () => {
  const connection = encodeClientFrame(EVENT.StartConnection, {});
  assert.deepEqual(
    [...connection.subarray(0, 8)],
    [0x11, 0x14, 0x10, 0x00, 0x00, 0x00, 0x00, 0x01],
  );
  // 连接级帧没有 session id：事件号后直接是负载长度。
  assert.equal(connection.readUInt32BE(8), 2);

  const task = encodeClientFrame(
    EVENT.TaskRequest,
    { event: EVENT.TaskRequest },
    'session-1',
  );
  assert.equal(task.readInt32BE(4), EVENT.TaskRequest);
  const sessionIdLength = task.readUInt32BE(8);
  assert.equal(sessionIdLength, 'session-1'.length);
  assert.equal(
    task.subarray(12, 12 + sessionIdLength).toString('utf8'),
    'session-1',
  );
});

test('parses audio-only frames and JSON responses with optional response ids', () => {
  const audio = serverFrame({
    messageType: MESSAGE_TYPES.AUDIO,
    event: EVENT.TTSResponse,
    payload: Buffer.from([0x01, 0x02, 0x03, 0x04]),
  });
  const parsedAudio = parseServerFrame(audio);
  assert.equal(parsedAudio.event, EVENT.TTSResponse);
  assert.deepEqual([...parsedAudio.audio], [0x01, 0x02, 0x03, 0x04]);

  const payload = Buffer.from(
    JSON.stringify({ status_code: API_SUCCESS_CODE }),
    'utf8',
  );
  const plain = parseServerFrame(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.SessionFinished,
      payload,
    }),
  );
  assert.equal(plain.event, EVENT.SessionFinished);
  assert.equal(plain.payloadMessage.status_code, API_SUCCESS_CODE);

  const withId = parseServerFrame(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.TTSResponse,
      payload,
      responseId: Buffer.from('resp-1', 'utf8'),
    }),
  );
  assert.equal(withId.payloadMessage.status_code, API_SUCCESS_CODE);
});

test('maps provider error frames to readable messages', () => {
  const frame = parseServerFrame(
    serverFrame({
      messageType: MESSAGE_TYPES.ERROR,
      payload: Buffer.from(
        JSON.stringify({ message: 'resource not found' }),
        'utf8',
      ),
      code: 45000001,
    }),
  );
  assert.equal(frame.code, 45000001);
});

test('translates the voice/tier mismatch code into an actionable hint', async () => {
  const events = [];
  const session = new DoubaoTtsSession(TTS_CONFIG, (event) => events.push(event), {
    WebSocketImpl: FakeWebSocket,
  });

  const started = session.start();
  const socket = lastInstance();
  socket.open();
  void started;
  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.ERROR,
      payload: Buffer.alloc(0),
      code: 55000000,
    }),
  );

  const failure = events.at(-1);
  assert.equal(failure.type, 'error');
  assert.match(failure.message, /档位不匹配/);
});

test('validates session status codes', () => {
  assert.equal(describeTtsStatus({ status_code: API_SUCCESS_CODE }), '');
  assert.equal(describeTtsStatus({}), '');
  assert.equal(describeTtsStatus(undefined), '');
  const problem = describeTtsStatus({
    status_code: 45000001,
    status_message: 'invalid resource id',
  });
  assert.match(problem, /45000001/);
  assert.match(problem, /invalid resource id/);
});

test('builds session and task payloads with pcm audio params', () => {
  const session = createSessionPayload({ uid: 'u1', voice: 'v1', sampleRate: 24000, speechRate: 0 });
  assert.equal(session.event, EVENT.StartSession);
  assert.equal(session.namespace, 'BidirectionalTTS');
  assert.equal(session.req_params.text, '');
  assert.equal(session.req_params.speaker, 'v1');
  assert.deepEqual(session.req_params.audio_params, {
    format: 'pcm',
    sample_rate: 24000,
    speech_rate: 0,
  });

  const task = createTaskPayload({ uid: 'u1', voice: 'v1', sampleRate: 24000, speechRate: 0 }, '你好');
  assert.equal(task.event, EVENT.TaskRequest);
  assert.equal(task.req_params.text, '你好');
});

test('drives the full handshake and synthesis flow', async () => {
  const events = [];
  const session = new DoubaoTtsSession(TTS_CONFIG, (event) => events.push(event), {
    WebSocketImpl: FakeWebSocket,
    connectionTimeoutMs: 500,
    responseTimeoutMs: 5000,
  });

  const started = session.start();
  const socket = lastInstance();
  assert.equal(
    socket.options.headers['X-Api-Resource-Id'],
    'seed-tts-1.0',
  );
  socket.open();
  await started;

  // open 之后先发 StartConnection；speak() 提前调用时文本要等 SessionStarted 才发。
  assert.deepEqual(
    socket.sentEvents().map(({ event }) => event),
    [EVENT.StartConnection],
  );
  session.speak('你好，Hemi。');

  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.ConnectionStarted,
      payload: Buffer.from('{}', 'utf8'),
    }),
  );
  let sent = socket.sentEvents();
  assert.deepEqual(
    sent.map(({ event }) => event),
    [EVENT.StartConnection, EVENT.StartSession],
  );
  const startSession = sent.at(-1);
  assert.equal(startSession.payload.req_params.speaker, TTS_CONFIG.voice);
  assert.equal(startSession.sessionId, session.sessionId);

  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.SessionStarted,
      payload: Buffer.from('{"status_code":20000000}', 'utf8'),
    }),
  );

  sent = socket.sentEvents();
  const events_ = sent.map(({ event }) => event);
  assert.ok(events_.includes(EVENT.TaskRequest));
  assert.ok(events_.includes(EVENT.FinishSession));
  const task = sent.find(({ event }) => event === EVENT.TaskRequest);
  assert.equal(task.payload.req_params.text, '你好，Hemi。');
  assert.equal(events.find(({ type }) => type === 'started')?.type, 'started');

  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.AUDIO,
      event: EVENT.TTSResponse,
      payload: Buffer.from([0x10, 0x20]),
    }),
  );
  assert.deepEqual(events.find(({ type }) => type === 'audio')?.data, Buffer.from([0x10, 0x20]));

  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.SessionFinished,
      payload: Buffer.from('{"status_code":20000000}', 'utf8'),
    }),
  );
  assert.equal(events.at(-1).type, 'finished');
  // 收尾要发 FinishConnection 并以 1000 正常关闭。
  assert.equal(socket.sentEvents().at(-1).event, EVENT.FinishConnection);
  assert.equal(socket.closeArgs.code, 1000);
});

test('fails with a readable error when the provider rejects the session', () => {
  const events = [];
  const session = new DoubaoTtsSession(TTS_CONFIG, (event) => events.push(event), {
    WebSocketImpl: FakeWebSocket,
  });

  const started = session.start();
  const socket = lastInstance();
  socket.open();
  void started;

  socket.serverSend(
    serverFrame({
      messageType: MESSAGE_TYPES.FULL,
      serialization: 0x1,
      event: EVENT.SessionFailed,
      payload: Buffer.from('{"status_message":"resource not open"}', 'utf8'),
    }),
  );

  const failure = events.at(-1);
  assert.equal(failure.type, 'error');
  assert.match(failure.message, /resource not open/);
  assert.equal(socket.closeArgs.code, 1000);
});

test('treats a premature close as a failed synthesis', async () => {
  const events = [];
  const session = new DoubaoTtsSession(TTS_CONFIG, (event) => events.push(event), {
    WebSocketImpl: FakeWebSocket,
    connectionTimeoutMs: 500,
    responseTimeoutMs: 5000,
  });

  const started = session.start();
  lastInstance().open();
  await started;
  session.speak('断了');

  lastInstance().close(1006, Buffer.from('network reset'));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /意外关闭|完成前关闭/);
});

test('rejects start with an auth hint on unexpected responses', async () => {
  class RejectingSocket extends FakeWebSocket {
    constructor(...args) {
      super(...args);
      // 微任务时机：等 start() 注册好 once 处理器再拒绝握手。
      queueMicrotask(() => {
        this.emit(
          'unexpected-response',
          {},
          { statusCode: 403, headers: { 'x-tt-logid': 'log-9' } },
        );
      });
    }
  }

  const session = new DoubaoTtsSession(TTS_CONFIG, () => {}, {
    WebSocketImpl: RejectingSocket,
    connectionTimeoutMs: 500,
  });

  await assert.rejects(
    () => session.start(),
    /鉴权失败：HTTP 403/,
  );
});
