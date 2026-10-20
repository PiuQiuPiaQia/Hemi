// 014 浏览器桥 · 零依赖 WebSocket 服务端（RFC6455 受控子集）。
//
// 为什么手写：桥接服务跑在 Pi 扩展进程（userData 里的宿主 Node），拿不到
// Electron 的 node_modules；向 pi 安装目录塞依赖或跨目录复制 node_modules 都
// 引入新的资产链路。本地回环 + 单一可信客户端（自家 Chrome 扩展）的场景，
// 一个受控子集比引入依赖更稳。单测用 Node 22+ 内置 WebSocket 客户端对打。
//
// 覆盖面（也即边界）：
//  - 握手（Sec-WebSocket-Accept）、文本/二进制帧、分片消息（continuation）、
//    ping→pong、close 握手、客户端掩码解除；
//  - 不做：permessage-deflate、服务端分片发送、多客户端广播语义（hub 只留
//    最新一个可用连接，旧连接直接关闭——桥的两端都唯一）。
//
// 安全：只绑 127.0.0.1；Upgrade 校验 Origin 前缀（chrome-extension://）——
// 网页 JS 发起的跨源 WebSocket 带页面 Origin，会被直接拒绝（防网页扫描
// 本地端口劫持桥；本机恶意进程可伪造 Origin，不在此防线目标内，与方案 D-1 一致）。
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 单帧上限：截图 base64 可到几 MB，32MB 是防御值不是业务值。 */
const MAX_PAYLOAD = 32 * 1024 * 1024;
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/** 服务端→客户端帧：不掩码（RFC 要求客户端掩码、服务端不掩码）。 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 掩码解除（客户端→服务端帧必掩码）。len 是本帧载荷长度——同一 chunk 里
 *  可能紧跟后续帧，绝不能按 buffer 剩余长度解码（R-15 并行流量实录的串台 bug）。 */
function unmask(payload, mask, start, len) {
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = payload[start + i] ^ mask[i & 3];
  }
  return out;
}

/**
 * 增量帧解析器：喂 buffer，吐完整消息/控制帧。分片消息（opcode=0）累积到
 * FIN 才上抛；ping/close 等控制帧允许插在分片中间（RFC 6455 §5.4）。
 */
export function createFrameParser(handlers) {
  let buffer = Buffer.alloc(0);
  let fragments = null;
  let fragmentOpcode = 0;

  function deliver(opcode, payload) {
    if (payload.length > MAX_PAYLOAD) throw new Error('消息超限');
    if (opcode === OPCODE.text) handlers.onText?.(payload.toString('utf8'));
    else if (opcode === OPCODE.binary) handlers.onBinary?.(payload);
  }

  /** 解析一帧；完整则处理后返回剩余字节，不完整返回 null（等下一段）。close 之后返回空。 */
  function parseOne(frame) {
    const fin = (frame[0] & 0x80) !== 0;
    const opcode = frame[0] & 0x0f;
    const masked = (frame[1] & 0x80) !== 0;
    let len = frame[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      len = frame.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      const big = frame.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('帧超限');
      len = Number(big);
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (frame.length < offset + maskLen + len) return null;
    let payload = masked
      ? unmask(frame, frame.subarray(offset, offset + 4), offset + maskLen, len)
      : frame.subarray(offset + maskLen, offset + maskLen + len);
    const rest = frame.subarray(offset + maskLen + len);

    if (opcode === OPCODE.ping) {
      handlers.onPing?.(payload);
    } else if (opcode === OPCODE.pong) {
      handlers.onPong?.(payload);
    } else if (opcode === OPCODE.close) {
      handlers.onClose?.(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
      return Buffer.alloc(0); // close 之后不再消费同 buffer 里的东西
    } else if (opcode === OPCODE.continuation) {
      if (!fragments) throw new Error('意外的 continuation 帧');
      fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(fragments);
        const kind = fragmentOpcode;
        fragments = null;
        deliver(kind, whole);
      }
    } else if (fin) {
      deliver(opcode, payload);
    } else {
      fragments = [payload];
      fragmentOpcode = opcode;
    }
    return rest;
  }

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let guard = 0;
      while (buffer.length >= 2 && guard < 100000) {
        guard += 1;
        const rest = parseOne(buffer);
        if (rest === null) break;
        buffer = rest;
      }
      if (guard >= 100000) throw new Error('帧流异常：解析未收敛');
    },
    /** close 握手未完成就要销毁时，把残留 fragment 丢弃。 */
    reset() {
      buffer = Buffer.alloc(0);
      fragments = null;
    },
  };
}

/**
 * 桥服务端。listen({ ports }) 依次尝试绑定，成功后 resolve 实际端口；
 * 同一时刻只服务一个连接：新连接进来时旧连接被主动关闭（两端都唯一，
 * 重连场景＝扩展 SW 重启，旧的半死连接不该占着位子）。
 */
export class BrowserWsHub extends EventEmitter {
  constructor({ host = '127.0.0.1', originPrefix = 'chrome-extension://', log = null } = {}) {
    super();
    this.host = host;
    this.originPrefix = originPrefix;
    this.log = log;
    this.http = null;
    this.port = null;
    this.client = null; // { id, socket, sendText, sendBinary, close }
  }

  get connected() {
    return Boolean(this.client);
  }

  sendText(text) {
    if (!this.client) throw new Error('浏览器桥未连接');
    this.client.sendText(String(text));
  }

  listen({ ports }) {
    return new Promise((resolve, reject) => {
      const errors = [];
      const attempt = (index) => {
        if (index >= ports.length) {
          reject(new Error(`浏览器桥端口全部被占用（${ports.join(', ')}）：${errors.join('；')}`));
          return;
        }
        const port = ports[index];
        const http = createServer((_req, res) => {
          // 普通 HTTP 请求（非 Upgrade）＝022 报忙探针的桥指纹：回可识别标记头，
          // 不完成 Upgrade，因此不会触发「新连接顶掉旧客户端」——探测绝不打扰
          // 在跑任务；随机本地服务不会带这个头。
          res.writeHead(200, { 'x-hemi-bridge': '1' });
          res.end();
        });
        http.once('error', (error) => {
          http.close();
          errors.push(`${port}: ${error.message}`);
          attempt(index + 1);
        });
        http.on('upgrade', (req, socket) => this.handleUpgrade(req, socket, port));
        http.listen(port, this.host, () => {
          this.http = http;
          this.port = port;
          this.emit('listening', port);
          resolve(port);
        });
      };
      attempt(0);
    });
  }

  handleUpgrade(req, socket, port) {
    const key = req.headers['sec-websocket-key'];
    const origin = String(req.headers.origin ?? '');
    const version = req.headers['sec-websocket-version'];
    const fail = (reason) => {
      this.log?.debug?.(`[browser-ws] 握手拒绝：${reason}`);
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || String(version) !== '13') {
      fail('不是合法的 WebSocket 握手');
      return;
    }
    if (!origin.startsWith(this.originPrefix)) {
      fail(`Origin 不受信任：${origin || '(空)'}`);
      return;
    }
    if (this.client) {
      // 唯一客户端语义：新连接顶掉旧连接（旧 SW 已死或半死）。
      this.log?.info?.('[browser-ws] 新连接接入，关闭旧连接');
      this.dropClient(this.client, 1001);
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n',
    );
    socket.setNoDelay(true);
    const client = {
      id: randomUUID(),
      socket,
      origin,
      port,
      sendText: (text) => this.write(client, encodeFrame(OPCODE.text, Buffer.from(String(text), 'utf8'))),
      sendBinary: (buf) => this.write(client, encodeFrame(OPCODE.binary, buf)),
      close: (code = 1000) => {
        try {
          const body = Buffer.alloc(2);
          body.writeUInt16BE(code, 0);
          socket.write(encodeFrame(OPCODE.close, body));
        } catch {
          /* socket 已死就算了 */
        }
        socket.end();
      },
    };
    const parser = createFrameParser({
      onText: (text) => this.emit('text', client, text),
      onBinary: (buf) => this.emit('binary', client, buf),
      onPing: (payload) => {
        try {
          this.write(client, encodeFrame(OPCODE.pong, payload));
        } catch {
          /* 忽略 */
        }
      },
      onClose: () => this.dropClient(client, 1000),
    });
    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.log?.warn?.(`[browser-ws] 帧解析失败，断开：${error.message}`);
        this.dropClient(client, 1002);
      }
    });
    socket.on('close', () => this.dropClient(client));
    socket.on('error', () => this.dropClient(client));
    this.client = client;
    this.emit('connection', client);
  }

  write(client, frame) {
    if (this.client !== client || client.socket.destroyed) throw new Error('浏览器桥连接已断开');
    client.socket.write(frame);
  }

  dropClient(client, code = null) {
    if (this.client !== client) return;
    if (code) {
      // 先发 close 帧再断（此时 this.client 还指着它，write 才放行）。
      try {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        client.socket.write(encodeFrame(OPCODE.close, body));
      } catch {
        /* socket 已死就算了 */
      }
    }
    this.client = null;
    try {
      client.socket.destroy();
    } catch {
      /* 已销毁 */
    }
    this.emit('close', client);
  }

  close() {
    if (this.client) this.dropClient(this.client, 1001);
    if (this.http) {
      try {
        this.http.close();
      } catch {
        /* 已关 */
      }
      this.http = null;
      this.port = null;
    }
  }
}
