/**
 * 输出上限兜底（2026-11 用户裁决）。
 *
 * 型号目录命中时一律用目录值，再由 pi-ai 按上下文窗口余量裁剪
 * （`clampMaxTokensToContext`）；只有目录查不到的自定义端点／私有型号才用这个兜底。
 * 值取 32768：够长回答与工具调用用，又不至于把未知端点的请求撑爆。
 *
 * 单独成模块是因为 `lib/pi-model.mjs` 与 `services/oauth-models.mjs` 互相依赖，
 * 常量放任何一边都会形成循环引用。
 */
export const FALLBACK_OUTPUT_TOKENS = 32768;
