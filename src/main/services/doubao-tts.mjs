import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import WebSocket from 'ws';

/**
 * 豆包双向流式语音合成（v3）客户端。
 *
 * 与 doubao-asr.mjs 同一协议家族（四字节头 + 消息类型 + JSON 负载），但它是
 * 事件驱动而不是序号驱动：客户端按 StartConnection → StartSession →
 * TaskRequest → FinishSession 的顺序发事件，服务端以事件 + 纯音频帧回应。
 * 本类只管协议与会话生命周期；连接的持有与单飞（新播报掐旧播报）在 main.mjs。
 */

const MESSAGE = {
  FULL_CLIENT_REQUEST: 0x1,
  FULL_SERVER_RESPONSE: 0x9,
  AUDIO_ONLY_RESPONSE: 0xb,
  ERROR_RESPONSE: 0xf,
};

const SERIALIZATION = {
  NONE: 0x0,
  JSON: 0x1,
};

const COMPRESSION = {
  NONE: 0x0,
  GZIP: 0x1,
};

/** 消息带事件号的标志位。 */
const FLAG_WITH_EVENT = 0x4;

export const EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSResponse: 352,
};

export const TTS_NAMESPACE = 'BidirectionalTTS';
export const API_SUCCESS_CODE = 20000000;
export const DEFAULT_TTS_SAMPLE_RATE = 24000;

const CONNECTION_TIMEOUT_MS = 8000;
/** speak() 之后多久没收到任何帧视为断流。 */
const RESPONSE_TIMEOUT_MS = 15000;

function int32BigEndian(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function uint32BigEndian(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/**
 * 客户端事件帧：四字节头 + 事件号 +（可选）session id + JSON 负载。
 * 连接级事件不带 session id，会话级事件必须带。
 */
export function encodeClientFrame(event, payload = {}, sessionId = '') {
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const parts = [
    Buffer.from([
      0x11,
      (MESSAGE.FULL_CLIENT_REQUEST << 4) | FLAG_WITH_EVENT,
      (SERIALIZATION.JSON << 4) | COMPRESSION.NONE,
      0x00,
    ]),
    int32BigEndian(event),
  ];

  if (sessionId) {
    const sessionBuffer = Buffer.from(sessionId, 'utf8');
    parts.push(uint32BigEndian(sessionBuffer.length), sessionBuffer);
  }

  parts.push(uint32BigEndian(payloadBuffer.length), payloadBuffer);
  return Buffer.concat(parts);
}

function decodePayload(payload, serialization, compression) {
  let bytes = payload;
  if (compression === COMPRESSION.GZIP && bytes.length) {
    bytes = gunzipSync(bytes);
  }
  const text = bytes.toString('utf8');
  if (!text) return null;
  if (serialization !== SERIALIZATION.JSON) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 负载前可能先带一段 response id（长度对不上时就按「id + 再一个 uint32 + 负载」
 * 读），与官方 demo 的容错一致。
 */
function readPayloadTolerant(buffer, offset) {
  if (offset >= buffer.length) return Buffer.alloc(0);
  if (offset + 4 > buffer.length) {
    throw new Error('豆包 TTS 响应负载不完整。');
  }

  const firstLength = buffer.readUInt32BE(offset);
  offset += 4;

  if (firstLength === buffer.length - offset) {
    return buffer.subarray(offset, offset + firstLength);
  }

  if (offset + firstLength > buffer.length) {
    throw new Error('豆包 TTS 响应负载长度超出实际帧长度。');
  }
  offset += firstLength;

  if (offset + 4 > buffer.length) {
    throw new Error('豆包 TTS 响应负载不完整。');
  }
  const payloadLength = buffer.readUInt32BE(offset);
  offset += 4;
  if (offset + payloadLength > buffer.length) {
    throw new Error('豆包 TTS 响应负载长度超出实际帧长度。');
  }
  return buffer.subarray(offset, offset + payloadLength);
}

/** 解析服务端帧：事件号 + JSON 负载，或纯音频帧（messageType 0xb）。 */
export function parseServerFrame(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 4) {
    throw new Error('豆包 TTS 返回了不完整的协议头。');
  }

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >>> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >>> 4;
  const compression = buffer[2] & 0x0f;
  if (headerSize < 4 || headerSize > buffer.length) {
    throw new Error('豆包 TTS 返回了无效的协议头长度。');
  }

  const result = { code: 0, event: 0, audio: null, payloadMessage: null };
  let offset = headerSize;

  if (messageType === MESSAGE.ERROR_RESPONSE) {
    if (offset + 8 > buffer.length) {
      throw new Error('豆包 TTS 错误响应不完整。');
    }
    result.code = buffer.readInt32BE(offset);
    const payloadSize = buffer.readUInt32BE(offset + 4);
    offset += 8;
    result.payloadMessage = decodePayload(
      buffer.subarray(offset, offset + payloadSize),
      serialization,
      compression,
    );
    return result;
  }

  if (
    messageType !== MESSAGE.FULL_SERVER_RESPONSE &&
    messageType !== MESSAGE.AUDIO_ONLY_RESPONSE
  ) {
    throw new Error(`豆包 TTS 返回了未知消息类型：${messageType}。`);
  }

  if (flags & FLAG_WITH_EVENT) {
    if (offset + 4 > buffer.length) {
      throw new Error('豆包 TTS 响应缺少事件编号。');
    }
    result.event = buffer.readInt32BE(offset);
    offset += 4;
  }

  const payload = readPayloadTolerant(buffer, offset);
  if (messageType === MESSAGE.AUDIO_ONLY_RESPONSE) {
    result.audio = compression === COMPRESSION.GZIP && payload.length
      ? gunzipSync(payload)
      : payload;
  } else {
    result.payloadMessage = decodePayload(payload, serialization, compression);
  }
  return result;
}

function payloadStatusCode(payloadMessage) {
  if (!payloadMessage || typeof payloadMessage !== 'object') return undefined;
  const code = payloadMessage.status_code ?? payloadMessage.code;
  return typeof code === 'number' ? code : undefined;
}

function payloadMessageText(payloadMessage) {
  if (typeof payloadMessage === 'string' && payloadMessage.trim()) {
    return payloadMessage.trim();
  }
  if (payloadMessage && typeof payloadMessage === 'object') {
    const message = payloadMessage.status_message ?? payloadMessage.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return '';
}

/**
 * 会话级状态码校验：成功（20000000 / 0 / 缺省）返回空串，失败返回中文可读错误。
 */
export function describeTtsStatus(payloadMessage) {
  const statusCode = payloadStatusCode(payloadMessage);
  if (
    statusCode === undefined ||
    statusCode === 0 ||
    statusCode === API_SUCCESS_CODE
  ) {
    return '';
  }
  const detail =
    payloadMessageText(payloadMessage) || JSON.stringify(payloadMessage);
  return `豆包 TTS 返回错误码 ${statusCode}：${detail}`;
}

/** 常见错误码的人话提示（服务端 payload 常为空，只能按码翻译）。 */
const ERROR_HINTS = {
  // 音色与资源档位不匹配（如 1.0 音色配 2.0 资源）。
  55000000:
    '音色与 Resource ID 档位不匹配，请在设置中让音色与资源同为 2.0 档或同为 1.0 档。',
};

function readableTtsError(payloadMessage, fallback, code) {
  const detail = payloadMessageText(payloadMessage);
  if (detail) return detail;
  if (code !== undefined && ERROR_HINTS[code]) return ERROR_HINTS[code];
  return fallback;
}

function requestParams(config, text) {
  return {
    user: { uid: config.uid },
    namespace: TTS_NAMESPACE,
    req_params: {
      text,
      speaker: config.voice,
      audio_params: {
        format: 'pcm',
        sample_rate: config.sampleRate || DEFAULT_TTS_SAMPLE_RATE,
        speech_rate: config.speechRate ?? 0,
      },
    },
  };
}

/** StartSession 的负载：文本留空，音频参数在这里声明。 */
export function createSessionPayload(config) {
  return { ...requestParams(config, ''), event: EVENT.StartSession };
}

/** TaskRequest 的负载：整句待合成的文本。 */
export function createTaskPayload(config, text) {
  return { ...requestParams(config, text), event: EVENT.TaskRequest };
}

export class DoubaoTtsSession {
  /**
   * @param {object} config { apiKey, resourceId, endpoint, voice, sampleRate?, speechRate?, uid? }
   * @param {(event: object) => void} emit
   *   事件：{type:'started'} | {type:'audio', data:Buffer} | {type:'finished'}
   *   | {type:'error', message, code?}
   * @param {object} [options] WebSocketImpl / 超时可注入，供离线测试。
   */
  constructor(config, emit, options = {}) {
    this.config = config;
    this.emit = emit;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;

    this.uid = config.uid || `hemi-desktop-${randomUUID()}`;
    this.socket = null;
    this.sessionId = '';
    this.pendingText = '';
    this.sessionActive = false;
    this.spoken = false;
    this.closed = false;
    this.finished = false;
    this.watchdog = null;
  }

  /** 建连 + 发 StartConnection；握手余下的部分由事件驱动继续。 */
  async start() {
    if (this.socket) throw new Error('豆包 TTS 会话已经启动。');

    this.sessionId = randomUUID();
    const socket = new this.WebSocketImpl(this.config.endpoint, {
      perMessageDeflate: false,
      headers: {
        'X-Api-Key': this.config.apiKey,
        'X-Api-Resource-Id': this.config.resourceId,
        'X-Api-Connect-Id': this.sessionId,
      },
    });
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary) this.handleMessage(data);
    });
    socket.on('close', (code, reason) => this.handleClose(code, reason));

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error('连接豆包 TTS 超时，请检查网络和接口地址。'));
      }, this.connectionTimeoutMs);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('豆包 TTS 网络连接异常。'));
      };

      socket.once('error', fail);
      socket.once('unexpected-response', (_request, response) => {
        const logId = String(response.headers['x-tt-logid'] ?? '');
        const suffix = logId ? `（Log ID: ${logId}）` : '';
        fail(new Error(`豆包 TTS 鉴权失败：HTTP ${response.statusCode}${suffix}`));
      });
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('error', fail);
        socket.on('error', (error) =>
          this.fail(error?.message || '豆包 TTS 网络连接异常。'),
        );
        this.send(encodeClientFrame(EVENT.StartConnection, {}));
        this.armWatchdog();
        resolve();
      });
    });
  }

  /**
   * 提交待合成文本。可以在 start() 之后立即调用：若会话握手还没走完，
   * 文本会在 SessionStarted 时补发。
   */
  speak(text) {
    if (this.closed || this.spoken) return;
    this.spoken = true;
    this.pendingText = text;
    this.armWatchdog();
    this.flushTask();
  }

  /** 幂等关闭：尽量发 FinishConnection，失败直接断。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearWatchdog();

    const socket = this.socket;
    if (!socket) return;
    try {
      if (socket.readyState === this.WebSocketImpl.OPEN) {
        socket.send(
          encodeClientFrame(EVENT.FinishConnection, {}),
          { binary: true },
        );
        socket.close(1000, 'client finished');
      } else {
        socket.terminate();
      }
    } catch {
      // 关闭路径上的异常一律忽略：会话已经结束了。
    }
  }

  send(frame) {
    if (this.closed) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    socket.send(frame, { binary: true });
  }

  flushTask() {
    if (!this.pendingText || !this.sessionActive) return;
    const text = this.pendingText;
    this.pendingText = '';
    const taskConfig = {
      uid: this.uid,
      voice: this.config.voice,
      sampleRate: this.config.sampleRate,
      speechRate: this.config.speechRate,
    };
    this.send(
      encodeClientFrame(
        EVENT.TaskRequest,
        createTaskPayload(taskConfig, text),
        this.sessionId,
      ),
    );
    this.send(
      encodeClientFrame(EVENT.FinishSession, {}, this.sessionId),
    );
  }

  handleMessage(data) {
    if (this.closed || this.finished) return;

    let response;
    try {
      response = parseServerFrame(data);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '无法解析豆包 TTS 响应。');
      return;
    }
    this.resetWatchdog();

    if (response.code && response.code !== API_SUCCESS_CODE) {
      this.fail(
        readableTtsError(
          response.payloadMessage,
          `豆包 TTS 请求失败（代码 ${response.code}）。`,
          response.code,
        ),
        response.code,
      );
      return;
    }

    switch (response.event) {
      case EVENT.ConnectionStarted: {
        const sessionConfig = {
          uid: this.uid,
          voice: this.config.voice,
          sampleRate: this.config.sampleRate,
          speechRate: this.config.speechRate,
        };
        this.send(
          encodeClientFrame(
            EVENT.StartSession,
            createSessionPayload(sessionConfig),
            this.sessionId,
          ),
        );
        break;
      }
      case EVENT.SessionStarted:
        this.sessionActive = true;
        this.emit({ type: 'started' });
        this.flushTask();
        break;
      case EVENT.TTSResponse:
        if (response.audio?.length) {
          this.emit({ type: 'audio', data: Buffer.from(response.audio) });
        }
        break;
      case EVENT.SessionFinished: {
        const problem = describeTtsStatus(response.payloadMessage);
        if (problem) this.fail(problem);
        else this.complete();
        break;
      }
      case EVENT.ConnectionFailed:
      case EVENT.SessionFailed:
        this.fail(readableTtsError(response.payloadMessage, '豆包 TTS 会话失败。'));
        break;
      default:
        break;
    }
  }

  handleClose(code, reason) {
    if (this.finished) return;
    if (!this.closed && code !== 1000) {
      const reasonText = Buffer.from(reason || []).toString('utf8');
      this.fail(`豆包 TTS 连接意外关闭（${code}${reasonText ? `：${reasonText}` : ''}）。`);
      return;
    }
    // 正常关闭却没等到 SessionFinished：按半截合成处理，不假装播完了。
    this.fail('豆包 TTS 连接在合成完成前关闭。');
  }

  complete() {
    if (this.finished) return;
    this.finished = true;
    this.close();
    this.emit({ type: 'finished' });
  }

  fail(message, code) {
    if (this.finished) return;
    this.finished = true;
    this.close();
    this.emit({
      type: 'error',
      message,
      ...(code === undefined ? {} : { code }),
    });
  }

  armWatchdog() {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.fail('等待豆包 TTS 响应超时。');
    }, this.responseTimeoutMs);
  }

  resetWatchdog() {
    if (!this.finished && !this.closed) this.armWatchdog();
  }

  clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
