/**
 * 思考强度（033）——抽象档位到各厂商请求字段的映射层。
 *
 * 各家的「思考」参数完全不统一：OpenAI 兼容端点是 `reasoning_effort`、
 * DeepSeek 官方与火山 Ark 是 `thinking:{type}`、智谱 GLM 是
 * `thinking:{type, clear_thinking}`、Qwen/DashScope 是 `enable_thinking`
 * 布尔。048 起请求体翻译统一交 pi-ai（对话侧 pi-chat.mjs、执行侧
 * pi-session 均按 compat.thinkingFormat 构造）；本模块只保留档位/格式的
 * 归一（设置页与配置存储用）；URL 探测由 pi-ai 承担。
 *
 * 档位取 Pi SDK ThinkingLevel 的常用子集；`default`＝厂商中间档位
 * （openai 发 reasoning_effort:"medium"，deepseek/zai/qwen 等二值格式发
 * 「开思考」）——与执行器侧 SDK 自身默认（medium）对齐，两条链路同语义。
 */

export const THINKING_LEVELS = ['default', 'off', 'low', 'medium', 'high'];

/** default 档的等效档位：各厂商的中间档（二值格式即「开思考」）。 */
export const DEFAULT_LEVEL_TIER = 'medium';

/** 显式格式覆盖的可选值。 */
export const THINKING_FORMATS = ['openai', 'deepseek', 'zai', 'qwen'];

export function normalizeThinkingLevel(value) {
  return THINKING_LEVELS.includes(value) ? value : 'default';
}

/** 非法/缺省的显式格式返回 null（＝按 baseUrl 自动探测）。 */
export function normalizeThinkingFormat(value) {
  return THINKING_FORMATS.includes(value) ? value : null;
}
