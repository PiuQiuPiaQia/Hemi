import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import WebSocket from 'ws';

const MESSAGE = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
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

const AUDIO_CHUNK_BYTES = 6400;
const FINAL_RESPONSE_TIMEOUT_MS = 5500;
const CONNECTION_TIMEOUT_MS = 8000;

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

function createHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

export function encodeFullRequest(sequence, payload) {
  const compressedPayload = gzipSync(
    Buffer.from(JSON.stringify(payload), 'utf8'),
  );

  return Buffer.concat([
    createHeader(
      MESSAGE.FULL_CLIENT_REQUEST,
      0x1,
      SERIALIZATION.JSON,
      COMPRESSION.GZIP,
    ),
    int32BigEndian(sequence),
    uint32BigEndian(compressedPayload.length),
    compressedPayload,
  ]);
}

export function encodeAudioRequest(sequence, pcm16le, isFinal = false) {
  const compressedPayload = gzipSync(Buffer.from(pcm16le));
  const flags = isFinal ? 0x3 : 0x1;
  const wireSequence = isFinal
    ? -Math.abs(sequence)
    : Math.abs(sequence);

  return Buffer.concat([
    createHeader(
      MESSAGE.AUDIO_ONLY_REQUEST,
      flags,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP,
    ),
    int32BigEndian(wireSequence),
    uint32BigEndian(compressedPayload.length),
    compressedPayload,
  ]);
}

export function parseServerFrame(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 4) {
    throw new Error('豆包 ASR 返回了不完整的协议头。');
  }

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >>> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >>> 4;
  const compression = buffer[2] & 0x0f;

  if (headerSize < 4 || headerSize > buffer.length) {
    throw new Error('豆包 ASR 返回了无效的协议头长度。');
  }

  let offset = headerSize;
  let payloadSequence = 0;
  let event = 0;

  if (flags & 0x01) {
    if (offset + 4 > buffer.length) throw new Error('豆包 ASR 响应缺少序列号。');
    payloadSequence = buffer.readInt32BE(offset);
    offset += 4;
  }

  if (flags & 0x04) {
    if (offset + 4 > buffer.length) throw new Error('豆包 ASR 响应缺少事件编号。');
    event = buffer.readInt32BE(offset);
    offset += 4;
  }

  let code = 0;
  let payloadSize = 0;

  if (messageType === MESSAGE.FULL_SERVER_RESPONSE) {
    if (offset + 4 > buffer.length) throw new Error('豆包 ASR 响应缺少负载长度。');
    payloadSize = buffer.readUInt32BE(offset);
    offset += 4;
  } else if (messageType === MESSAGE.ERROR_RESPONSE) {
    if (offset + 8 > buffer.length) throw new Error('豆包 ASR 错误响应不完整。');
    code = buffer.readInt32BE(offset);
    payloadSize = buffer.readUInt32BE(offset + 4);
    offset += 8;
  } else {
    throw new Error(`豆包 ASR 返回了未知消息类型：${messageType}。`);
  }

  if (offset + payloadSize > buffer.length) {
    throw new Error('豆包 ASR 响应中的负载长度超出实际帧长度。');
  }

  let payload = buffer.subarray(offset, offset + payloadSize);
  if (compression === COMPRESSION.GZIP && payload.length) {
    payload = gunzipSync(payload);
  }

  let payloadMessage = payload.toString('utf8');
  if (serialization === SERIALIZATION.JSON && payloadMessage) {
    try {
      payloadMessage = JSON.parse(payloadMessage);
    } catch {
      // Keep the original UTF-8 string so diagnostic details are not lost.
    }
  }

  return {
    code,
    event,
    isLastPackage: Boolean(flags & 0x02),
    payloadSequence,
    payloadSize,
    payloadMessage,
    messageType,
  };
}

/** 按住说话允许思考停顿；仍实时出字，句末用二遍识别精修。 */
export function createRecognitionOptions(mode, { primarySpeakerEnabled = false } = {}) {
  return {
    nonstream: mode === 'hold',
    speakerInfo: mode === 'continuous' && primarySpeakerEnabled === true,
    endWindowSize: mode === 'hold' ? 1500 : 800,
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.nonstream=true] bigmodel_async 双向流式端点的
 *   enable_nonstream：开启句末二遍识别，临时结果仍实时返回；并非切换到
 *   bigmodel_nostream 单向流式端点。hold 开启；通话沿用说话人开关决定。
 * @param {boolean} [options.speakerInfo=false] 013：开启说话人区分（enable_speaker_info +
 *   ssd_version 200 + 二遍识别）。开启后分句事件带 speaker 编号（可能为 0）。
 * @param {number} [options.endWindowSize=800] 云端连续静音分句阈值（ms）。
 */
export function createRecognitionPayload({ nonstream = true, speakerInfo = false, endWindowSize = 800 } = {}) {
  return {
    user: {
      uid: `hemi-desktop-${randomUUID()}`,
    },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      enable_nonstream: nonstream,
      result_type: 'full',
      end_window_size: endWindowSize,
      force_to_speech_time: 1000,
      // 013：说话人区分需要二遍识别（双流式语境下 enable_nonstream 是开二遍，
      // 不是等整段说完）；关闭时 payload 与既有形状逐字节一致。
      ...(speakerInfo
        ? { enable_speaker_info: true, ssd_version: '200', enable_nonstream: true }
        : {}),
    },
  };
}

function normalizeResults(payloadMessage) {
  if (!payloadMessage || typeof payloadMessage !== 'object') return [];

  const result = payloadMessage.result;
  if (Array.isArray(result)) return result.filter(Boolean);
  return result && typeof result === 'object' ? [result] : [];
}

function readableError(payloadMessage, fallback) {
  if (typeof payloadMessage === 'string' && payloadMessage.trim()) {
    return payloadMessage.trim();
  }

  if (payloadMessage && typeof payloadMessage === 'object') {
    const message = payloadMessage.message ?? payloadMessage.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  return fallback;
}

export class DoubaoAsrSession {
  constructor(config, emit, { nonstream = true, speakerInfo = false, endWindowSize = 800, rawSink = null } = {}) {
    this.config = config;
    this.emit = emit;
    // 见 createRecognitionPayload：双向流式上的句末二遍识别开关。
    this.nonstream = nonstream;
    // 013：说话人区分（通话模式 + 用户开关时开启）。
    this.speakerInfo = speakerInfo;
    this.endWindowSize = endWindowSize;
    // 诊断钩子：提供时把每条 FullServerResponse 的 payloadMessage 原样上抛
    // （说话人字段实测等场景用，2026-09-20）。
    this.rawSink = rawSink;
    this.socket = null;
    this.sequence = 1;
    this.audioQueue = Buffer.alloc(0);
    this.finalizedUtterances = new Map();
    // Utterance ids are only unique inside one connection: `start_time` restarts
    // at 0 after a reconnect, so callers need a per-session prefix to keep
    // continuous listening from overwriting earlier transcripts.
    this.sessionPrefix = '';
    this.stopping = false;
    this.finished = false;
    this.logId = '';
    this.stopPromise = null;
    this.resolveStop = null;
    this.finalResponseTimer = null;
  }

  async start() {
    if (this.socket) throw new Error('豆包 ASR 会话已经启动。');

    const requestId = randomUUID();
    this.sessionPrefix = `${requestId}-`;
    const socket = new WebSocket(this.config.endpoint, {
      perMessageDeflate: false,
      headers: {
        'X-Api-Key': this.config.apiKey,
        'X-Api-Resource-Id': this.config.resourceId,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
      },
    });
    this.socket = socket;

    socket.on('upgrade', (response) => {
      this.logId = String(response.headers['x-tt-logid'] ?? '');
    });
    socket.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    socket.on('close', (code, reason) => this.handleClose(code, reason));

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error('连接豆包 ASR 超时，请检查网络和接口地址。'));
      }, CONNECTION_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) {
          this.emitError(error instanceof Error ? error.message : '豆包 ASR 网络连接异常。');
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('豆包 ASR 网络连接异常。'));
      };

      socket.once('error', fail);
      socket.once('unexpected-response', (_request, response) => {
        const logId = String(response.headers['x-tt-logid'] ?? '');
        const suffix = logId ? `（Log ID: ${logId}）` : '';
        fail(new Error(`豆包 ASR 鉴权失败：HTTP ${response.statusCode}${suffix}`));
      });
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('error', fail);
        socket.on('error', (error) => this.emitError(error.message));

        const request = encodeFullRequest(
          this.sequence,
          createRecognitionPayload({
            nonstream: this.nonstream,
            speakerInfo: this.speakerInfo,
            endWindowSize: this.endWindowSize,
          }),
        );
        this.sequence += 1;
        socket.send(request, { binary: true });
        this.emit({ type: 'session.started' });
        resolve();
      });
    });
  }

  sendAudio(audio) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.stopping ||
      !audio?.length
    ) {
      return;
    }

    this.audioQueue = Buffer.concat([this.audioQueue, Buffer.from(audio)]);

    while (this.audioQueue.length >= AUDIO_CHUNK_BYTES) {
      const chunk = this.audioQueue.subarray(0, AUDIO_CHUNK_BYTES);
      this.audioQueue = this.audioQueue.subarray(AUDIO_CHUNK_BYTES);
      this.socket.send(encodeAudioRequest(this.sequence, chunk), {
        binary: true,
      });
      this.sequence += 1;
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.finish();
      return;
    }

    this.stopping = true;
    const finalChunk = this.audioQueue.length
      ? this.audioQueue
      : Buffer.alloc(AUDIO_CHUNK_BYTES);
    this.audioQueue = Buffer.alloc(0);

    this.socket.send(encodeAudioRequest(this.sequence, finalChunk, true), {
      binary: true,
    });
    this.sequence += 1;

    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
      this.finalResponseTimer = setTimeout(() => {
        this.emitError('等待豆包 ASR 最终结果超时，已结束本次会话。');
        this.socket?.close(1000, 'final response timeout');
        this.finish();
      }, FINAL_RESPONSE_TIMEOUT_MS);
    });

    return this.stopPromise;
  }

  handleMessage(data, isBinary) {
    if (!isBinary) {
      this.emitError('豆包 ASR 返回了非二进制响应。');
      return;
    }

    try {
      const response = parseServerFrame(data);
      if (response.code !== 0 && response.code !== 20000000) {
        const message = readableError(
          response.payloadMessage,
          `豆包 ASR 返回错误码 ${response.code}。`,
        );
        this.emitError(message, response.code);
        this.socket?.close(1011, 'provider error');
        return;
      }

      this.emitTranscripts(response.payloadMessage);

      if (response.isLastPackage) {
        this.socket?.close(1000, 'session complete');
        this.finish();
      }
    } catch (error) {
      this.emitError(
        error instanceof Error ? error.message : '无法解析豆包 ASR 响应。',
      );
    }
  }

  emitTranscripts(payloadMessage) {
    this.rawSink?.(payloadMessage);
    const results = normalizeResults(payloadMessage);
    const partialUtterances = [];
    // 013：分句说话人提取。实测（2026-09-20 speaker-probe，bigmodel_async + ASR2.0）：
    // 编号在**二遍定稿**分句的 `additions.speaker_id`（字符串数字，"0" 是有效编号）；
    // 流式 partial 的 additions 没有它（聚类只发生在二遍）。顶层 speaker 字段是
    // 未来兼容位。聚合 partial 只有在「全部同编号」时才携带该编号——混合归属的
    // 聚合 partial 带空 speaker，由过滤层按未知处理（不让顶层全文绕过过滤）。
    let partialSpeaker = null;
    let partialSpeakerMixed = false;

    const extractSpeaker = (utterance) => {
      const raw = utterance.speaker
        ?? utterance.speaker_id
        ?? utterance.additions?.speaker_id;
      if (raw === null || raw === undefined || raw === '') return null;
      const num = Number(raw);
      return Number.isFinite(num) ? num : null;
    };

    for (const [resultIndex, result] of results.entries()) {
      const utterances = Array.isArray(result.utterances)
        ? result.utterances
        : [];

      if (!utterances.length) {
        if (typeof result.text === 'string' && result.text.trim()) {
          partialUtterances.push({ text: result.text.trim() });
          partialSpeakerMixed = true; // 顶层全文没有归属，不能当作已知说话人
        }
        continue;
      }

      for (const [utteranceIndex, utterance] of utterances.entries()) {
        if (!utterance || typeof utterance.text !== 'string') continue;
        const text = utterance.text.trim();
        if (!text) continue;

        const startTime = Number.isFinite(utterance.start_time)
          ? utterance.start_time
          : `index-${utteranceIndex}`;
        const utteranceId = `${this.sessionPrefix}${resultIndex}:${startTime}`;
        const speaker = extractSpeaker(utterance);

        if (utterance.definite === true) {
          if (this.finalizedUtterances.get(utteranceId) !== text) {
            this.finalizedUtterances.set(utteranceId, text);
            this.emit({
              type: 'transcript.final',
              text,
              utteranceId,
              definite: true,
              speaker,
            });
          }
        } else if (!this.finalizedUtterances.has(utteranceId)) {
          partialUtterances.push({ text, utteranceId });
          if (speaker === null) partialSpeakerMixed = true;
          else if (partialSpeaker === null) partialSpeaker = speaker;
          else if (partialSpeaker !== speaker) partialSpeakerMixed = true;
        }
      }
    }

    this.emit({
      type: 'transcript.partial',
      text: partialUtterances.map((utterance) => utterance.text).join(''),
      utterances: partialUtterances,
      definite: false,
      speaker: partialSpeakerMixed || partialSpeaker === null ? null : partialSpeaker,
    });
  }

  handleClose(code, reason) {
    if (!this.stopping && !this.finished && code !== 1000) {
      const reasonText = Buffer.from(reason).toString('utf8');
      const logSuffix = this.logId ? ` Log ID: ${this.logId}` : '';
      this.emitError(
        `豆包 ASR 连接意外关闭（${code}${reasonText ? `：${reasonText}` : ''}）。${logSuffix}`,
      );
    }
    this.finish();
  }

  emitError(message, code) {
    this.emit({
      type: 'error',
      message,
      ...(code === undefined ? {} : { code }),
    });
  }

  finish() {
    if (this.finished) return;
    this.finished = true;

    if (this.finalResponseTimer) {
      clearTimeout(this.finalResponseTimer);
      this.finalResponseTimer = null;
    }

    this.emit({ type: 'session.ended' });
    this.resolveStop?.();
    this.resolveStop = null;
  }
}

export const protocolConstants = {
  AUDIO_CHUNK_BYTES,
  MESSAGE,
};
