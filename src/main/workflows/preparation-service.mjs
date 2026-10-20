import { resolveRelativeDate } from "../../shared/workflow-parameter-defaults.mjs";
/**
 * 059 准备卡的参数校验（不处理对话、不调用模型）。
 *
 * 参数由用户表单或主 agent 结构化工具提供；只收所选流程声明字段。
 * 普通消息始终进入主 agent，不存在会话级补参模式。
 *
 * 优先级（契约 §4.3）：显式表单修改 > 本条消息明确值 > 保存默认；空串不偷偷恢复旧值
 * （unset 才是清除）。
 */

const REQUIRED_TYPES = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "enum",
  "date",
]);

/**
 * 宿主校验提取器补丁（纯函数）：只收声明字段、类型收敛、枚举越界拒。
 * @param {object} params
 * @param {Array<{key: string, type: string, options?: string[], required?: boolean}>} params.parameters 输入 schema
 * @param {object} params.current 当前已收集值
 * @param {{ set?: Record<string, unknown>, unset?: string[], questions?: string[] }} params.extracted 提取器原始输出
 * @returns {{ ok: boolean, values?: object, issues: Array<{code: string, field?: string, message: string}>, questions: string[], rejected: string[] }}
 */
export function validateExtraction({
  parameters,
  current,
  extracted,
  now,
  timeZone,
}) {
  const issues = [];
  const rejected = [];
  const questions = (
    Array.isArray(extracted?.questions) ? extracted.questions : []
  )
    .filter((q) => typeof q === "string" && q.trim())
    .slice(0, 5);
  const values = { ...(current ?? {}) };
  const declared = new Map(parameters.map((p) => [p.key, p]));

  // unset：仅声明的键生效；空串不是清除
  for (const key of Array.isArray(extracted?.unset) ? extracted.unset : []) {
    if (!declared.has(key)) {
      rejected.push(key);
      continue;
    }
    delete values[key];
  }

  for (const [key, rawValue] of Object.entries(extracted?.set ?? {})) {
    const param = declared.get(key);
    if (!param) {
      rejected.push(key); // 未声明字段：不进 values、不报错卡（只是忽略，防注入新字段）
      continue;
    }
    const verdict = coerceValue(param, rawValue, { now, timeZone });
    if (!verdict.ok) {
      issues.push({
        code: "invalid-value",
        field: key,
        message: `参数 ${param.key} ${verdict.reason}`,
      });
      continue;
    }
    values[key] = verdict.value;
  }

  // ready 判定：声明必填全部有值且无 issue
  for (const param of parameters) {
    if (!param.required) continue;
    const value = values[param.key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim())
    ) {
      issues.push({
        code: "missing-input",
        field: param.key,
        message: `缺少必填参数 ${param.label || param.key}`,
      });
    }
  }

  return { ok: issues.length === 0, values, issues, questions, rejected };
}

function coerceValue(param, rawValue, context = {}) {
  if (param.type === "date") {
    const text = String(rawValue).trim();
    const relative = resolveRelativeDate(text, context);
    const dates = (relative ?? text).split(/[～~]/);
    if (
      dates.length > 2 ||
      dates.some(
        (date) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          Number.isNaN(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date,
      )
    )
      return { ok: false, reason: "需要有效日期或日期范围" };
    return { ok: true, value: relative ?? text };
  }
  if (param.type === "files") {
    const files = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === "string"
        ? rawValue.split("\n").filter(Boolean)
        : null;
    return files && files.every((file) => typeof file === "string")
      ? { ok: true, value: files }
      : { ok: false, reason: "需要文件列表" };
  }
  const type = param.type;
  if (
    type === "string" ||
    type === "text" ||
    type === "date" ||
    type === "file" ||
    type === "files" ||
    type === "directory"
  ) {
    if (typeof rawValue !== "string") {
      return typeof rawValue === "number" || typeof rawValue === "boolean"
        ? { ok: true, value: String(rawValue) }
        : { ok: false, reason: `需要文本，得到 ${typeof rawValue}` };
    }
    return { ok: true, value: rawValue };
  }
  if (type === "number") {
    const n =
      typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
    if (!Number.isFinite(n)) return { ok: false, reason: "需要数字" };
    return { ok: true, value: n };
  }
  if (type === "boolean") {
    if (typeof rawValue === "boolean") return { ok: true, value: rawValue };
    const text = String(rawValue).trim().toLowerCase();
    if (["true", "是", "对", "开", "yes"].includes(text))
      return { ok: true, value: true };
    if (["false", "否", "关", "no"].includes(text))
      return { ok: true, value: false };
    return { ok: false, reason: "需要布尔值" };
  }
  if (type === "enum") {
    const options = Array.isArray(param.options) ? param.options : [];
    const text = String(rawValue).trim();
    const hit =
      options.find((o) => o === text) ??
      options.find((o) => o.toLowerCase() === text.toLowerCase());
    if (!hit) return { ok: false, reason: `须是 ${options.join("／")} 之一` };
    return { ok: true, value: hit };
  }
  return REQUIRED_TYPES.has(type)
    ? { ok: false, reason: `暂不支持类型 ${type}` }
    : { ok: false, reason: `未知类型 ${type}` };
}
