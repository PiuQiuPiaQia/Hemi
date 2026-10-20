/**
 * P1 会话自动标题（2026-10-08 用户裁决「模型生成短标题」）。
 *
 * 首条用户消息截 24 字做标题，同一类请求会在侧栏堆出一模一样的几行（「帮我在
 * 飞猪查广州到清迈的往…」×3）。首轮回复落盘后，用会话所选的主脑模型生成一个
 * ≤12 字的短标题：手动重命名永远优先；首条消息被编辑后标题按新内容重新生成
 * （autoTitleFor 记生成依据，对不上即作废）。失败只记日志、保留截断标题，同一
 * 依据本次运行内不重试——标题是锦上添花，不能拖累对话。
 *
 * 本模块是纯逻辑（不 import Electron/模型）：模型调用由宿主注入（conversation.ipc）。
 */

/** 生成标题的长度上限（码点）：提示词要 ≤12，模型偶尔多出几个字仍可接受。 */
export const AUTO_TITLE_LIMIT = 20;

/** 首个有主题的用户回合；跳过误触数字/问候，回复不得跨过下一个用户回合。 */
function titlePair(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if (turn?.author !== 'user' || turn.withdrawn || !text) continue;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(text) || /^(你好[呀啊]?|您好|嗨|hello|hi|hey)[!！。.?？\s]*$/i.test(text)) continue;
    let reply = '';
    for (const candidate of list.slice(index + 1)) {
      if (candidate?.author === 'user') break;
      if (candidate?.author === 'hemi' && candidate.kind !== 'task' && candidate.kind !== 'error' && candidate.text?.trim()) {
        reply = candidate.text.trim();
        break;
      }
    }
    return { source: text, reply };
  }
  return { source: '', reply: '' };
}

/** 生成依据：首个有主题的用户消息；没有则等待后续消息。 */
export function titleSource(turns) {
  return titlePair(turns).source;
}

/** 首条用户消息之后的第一条 Hemi 回复（任务卡不算）；没有返回空串。 */
export function firstReply(turns) {
  return titlePair(turns).reply;
}

export function buildTitlePrompt({ userText, replyText = '' }) {
  const system = [
    '你给一段对话起标题，标题显示在会话列表里。',
    '要求：中文不超过 12 个字（对话是英文就用不超过 6 个词的英文）；概括用户要办的事或问的主题，具体到对象（地点、文件、产品名）；',
    '不要「帮我」「请」「关于」之类的开头，不要引号、书名号、句末标点、表情；只输出标题本身，不要任何解释。',
  ].join('\n');
  const user = [
    `用户：${String(userText ?? '').trim().slice(0, 800)}`,
    replyText ? `助手：${String(replyText).trim().slice(0, 400)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 模型输出清洗：取首个非空行，摘思考块/前缀/引号/句末标点；不合格返回 null。 */
export function normalizeGeneratedTitle(raw) {
  if (typeof raw !== 'string') return null;
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const line = withoutThinking
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  const cleaned = line
    .replace(/^(?:标题|title)\s*[:：]\s*/i, '')
    .replace(/^[#*\s`"'“”‘’「」『』《》【】]+/u, '')
    .replace(/[`"'“”‘’「」『』《》【】*\s。.!！?？,，;；:：、~～]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (Array.from(cleaned).length > AUTO_TITLE_LIMIT) return null;
  return cleaned;
}

/**
 * 自动标题调度：按会话串行、同一（会话, 依据）只试一次。
 *
 * @param {object} options
 * @param {{ autoTitleCandidate(id: string): ({ source: string, reply: string, profileId: string|null }|null),
 *           setAutoTitle(id: string, payload: { title: string, source: string }): ({ ok: boolean, session?: object }|null) }} options.store
 * @param {(request: { messages: Array, profileId: string|null }) => Promise<string>} options.runModel
 * @param {(session: object) => void} [options.onTitled]
 * @param {object} [options.log]
 * @param {() => number} [options.nowFn]
 */
export function createAutoTitler({ store, runModel, onTitled = () => {}, log = null, nowFn = Date.now }) {
  const attempted = new Set();
  const queue = [];
  let running = null;

  async function runJob(id) {
    const candidate = store.autoTitleCandidate(id);
    if (!candidate) return;
    const key = `${id}\u0000${candidate.source}`;
    if (attempted.has(key)) return;
    attempted.add(key);
    const startedAt = nowFn();
    try {
      const raw = await runModel({
        messages: buildTitlePrompt({ userText: candidate.source, replyText: candidate.reply }),
        profileId: candidate.profileId,
        // 048：自动标题的模型调用按会话记账（runModel 回执侧落用量账本）。
        conversationId: id,
      });
      const title = normalizeGeneratedTitle(raw);
      if (!title) {
        log?.info?.(`${id} 自动标题未采纳（输出不合格）`);
        return;
      }
      const result = store.setAutoTitle(id, { title, source: candidate.source });
      if (result?.ok && result.session) {
        log?.info?.(`${id} 自动标题 ${nowFn() - startedAt}ms：${title}`);
        onTitled(result.session);
      }
    } catch (error) {
      log?.warn?.(`${id} 自动标题失败：${error?.message ?? error}`);
    }
  }

  function drain() {
    if (running || !queue.length) return running;
    const id = queue.shift();
    running = runJob(id).finally(() => {
      running = null;
      drain();
    });
    return running;
  }

  return {
    /** 落盘成功后调用；不满足条件（已有手动/有效自动标题、还没回复等）时什么都不做。 */
    schedule(id) {
      const sessionId = String(id ?? '');
      if (!sessionId || queue.includes(sessionId)) return;
      queue.push(sessionId);
      drain();
    },
    /** 测试用：等队列跑空。 */
    async idle() {
      while (running) await running;
    },
  };
}
