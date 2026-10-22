/**
 * 055 R-01 · 口——输出适配层（主进程侧）。
 *
 * 主 agent 自由作答（长短结构按问题需要）；需要出声时（语音输入、或用户开启的
 * 播报场景），口把原文压成一句口语交给 TTS／字幕：只改写说法，不新增事实
 * （050 回炉「只复述已有事实」的口径推广到全部回答）。打字输入默认不播，
 * 播不播的判定在调用方（llm.ipc 按 inputSource），口只管「怎么压」。
 *
 * 轻量调用，单发不进主 agent 会话；模型选择按 Q5 裁决（resolveLightModel）。
 */

import { chatTurn } from './text-model.mjs';

/** 口的压缩提示词：渠道规则（一句话、能念、不用 markdown）只住在这里。 */
const MOUTH_SYSTEM_PROMPT = [
  '你是 Hemi 的语音转述器。用户刚听到的问题下面跟着一份完整回答（可能很长、带 Markdown 结构）。',
  '把回答压成一句口语播报，要求：',
  '1. 只回一句话，是完整的中文口语句子，能直接念出来；不用 markdown、不用列表、不用 emoji。',
  '2. 第一句就说结论；细节留在屏幕上，需要时说「详情在屏幕上」。',
  '3. 只改写说法，不新增回答里没有的事实；回答标注了不确定或未核实的地方，语气保留这份不确定。',
  '4. 回答本身已经很短时，原样或微调即可，不硬压成残句。',
].join('\n');

/**
 * 压一句口语播报。失败抛错（调用方降级：不播或念原文，不谎报成功）。
 * @param {object} options
 * @param {object} options.config 轻量模型（resolveLightModel 产物；baseUrl/apiKey/model/api/thinkingFormat）
 * @param {string} options.question 本轮用户问的话（锚定「这是在答什么」）
 * @param {string} options.answer 主 agent 的完整回答原文
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.kind] 'answer'（对话回答，缺省）｜'task'（任务交代——
 *        正文已显示在任务卡，播报只说结论与去向）
 * @returns {Promise<string>} 一句口语
 */
export async function summarizeForSpeech({ config, question, answer, signal, kind = 'answer', executionContext = null } = {}) {
  const text = String(answer ?? '').trim();
  if (!text) throw new Error('没有可转述的回答。');
  // 任务交代沿用 050 的锚定纪律：任务原文钉死唯一事实来源，别的任务内容不掺和。
  const anchor = kind === 'task' && question
    ? `当前任务原文：「${String(question).trim().slice(0, 160)}」。下面的回答就是针对这个任务的交代；不要拿别的内容判断它「不搭」。`
    : '';
  const final = await chatTurn({
    runtimeExecution: executionContext,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    api: config.api,
    oauthProvider: config.oauthProvider,
    messages: [
      { role: 'system', content: MOUTH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          anchor,
          `用户的问题：${String(question ?? '').trim().slice(0, 400) || '（无）'}`,
          `完整回答：\n${text.slice(0, 12000)}`,
        ].filter(Boolean).join('\n\n'),
      },
    ],
    thinkingLevel: 'off',
    thinkingFormat: config.thinkingFormat,
    signal,
    maxPreStreamRetries: 0,
  });
  const speech = final.content.trim();
  if (!speech) throw new Error('转述没有返回内容。');
  return speech;
}
