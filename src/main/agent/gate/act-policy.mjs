// 021 · browser_act 循环的纯决策策略（无 IO、无环境读取，全部可单测）。
//
// 为什么单独成模块：020 的置信度分层/熔断/核验逻辑内联在 pi-browser 的工具
// execute 里，review 基线（2026-09-21）发现的四个 P1/P2（目标置信度被丢弃、
// WAIT 被地板线误熔断、进展签名只比元素数量、已执行后失败被标未执行）全都
// 藏在那段循环里没法直测。本模块把「判定」与「执行」拆开：这里只回答
// 「这一步能不能走、为什么不能」，pi-browser 只负责按判定派发动作。

/** 决策端默认阈值（020 延续）：PASS 直接执行线，FLOOR 熔断地板线。 */
export const DEFAULT_PASS = 0.7;
export const DEFAULT_FLOOR = 0.4;

/**
 * 021 裁决（2026-09-21 真机实录 task-1-mubanvq7）：无副作用操作豁免地板线。
 * WAIT 置信 0.38 < 0.4 被计低置信熔断——等待不产生不可逆变更，不该与点击共用
 * 同一条生死线。豁免只作用于 FLOOR/PASS 两道置信度门；核验、无进展熔断、
 * waitRun 熔断与权限策略照常约束。新增操作必须在这里显式归类，不默认豁免。
 */
export const FLOOR_EXEMPT_OPS = ['WAIT', 'SCROLL_DOWN', 'SCROLL_UP'];

/** 有副作用的操作：置信度门槛、执行事实记账、无进展熔断都围绕它们。 */
export const SIDE_EFFECT_OPS = ['CLICK', 'TYPE_TEXT', 'SELECT'];

const EXEMPT = new Set(FLOOR_EXEMPT_OPS);
const SIDE_EFFECT = new Set(SIDE_EFFECT_OPS);

/** 合法置信度：有限数且在 0～1；缺失/NaN/越界一律 null（不得直通，AC-05）。 */
export function validConf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * 有效置信度（R-05）：有目标的动作取「操作、目标」两者最小值并要求二者都合法；
 * 目标置信度缺失/非法＝这一步没有执行资格（review 基线 P1：操作 0.99 / 目标 0.1
 * 仍被发出）。无目标动作只看操作值。DONE/BLOCKED 等无目标判断不受影响。
 */
export function effectiveConfidence(decision) {
  const op = validConf(decision?.operationConfidence);
  if (decision?.target == null) return op;
  const target = validConf(decision?.targetConfidence);
  if (op == null || target == null) return null;
  return Math.min(op, target);
}

/**
 * 阈值配置防御（R-05）：0≤FLOOR<PASS≤1 才可用，否则回默认值——
 * 环境变量是字符串、可能被配反，错误配置不能把安全线整个拆掉。
 */
export function resolveThresholds(pass = DEFAULT_PASS, floor = DEFAULT_FLOOR) {
  const p = validConf(Number(pass));
  const f = validConf(Number(floor));
  if (p == null || f == null || !(f < p)) return { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR };
  return { pass: p, floor: f };
}

export function isFloorExempt(op) {
  return EXEMPT.has(op);
}

export function isSideEffect(op) {
  return SIDE_EFFECT.has(op);
}

/**
 * 无进展签名（R-10）：比较相关状态而不是元素数量——标题/地址之外，
 * 用扩展侧的内容摘要（元素表 + 正文证据的哈希）与滚动位置。翻页/滚动会改
 * 摘要或 scrollY，不再误熔断；真正原地重复（同内容 + 同决策）才累加。
 */
export function progressSignature(snap, decision) {
  return JSON.stringify([
    snap?.title ?? '',
    snap?.url ?? '',
    snap?.digest ?? '',
    snap?.scrollY ?? null,
    decision?.op ?? '',
    decision?.target ?? null,
  ]);
}

/** 完成核验的快照身份（R-08）：内容摘要 + 证据摘要 + 滚动位置全等才算同一画面。 */
export function snapIdentity(snap) {
  return JSON.stringify([
    snap?.title ?? '',
    snap?.url ?? '',
    snap?.digest ?? '',
    snap?.scrollY ?? null,
    snap?.evidence?.digest ?? '',
  ]);
}

/**
 * 有界稳定判定（R-08）：身份序列里最后两个相等才算稳定——DONE 时拍一张，
 * 再有界轮询补拍，连续相同才认定结果区不再变化；两次立即相同不够，一直
 * 不相等也不稳定（保持 unknown，交给 verify-failed 收口）。
 */
export function isStableSequence(ids) {
  if (!Array.isArray(ids) || ids.length < 2) return false;
  return ids[ids.length - 1] === ids[ids.length - 2];
}

/**
 * 执行事实聚合（R-09）：子目标终态 ≠ 动作执行状态。有已确认执行成功的副作用
 * 动作而非 done ＝ partially-executed；动作已发出但回执丢失 ＝ dispatched-unknown；
 * 一步都没发出过副作用动作才是 not-executed。
 */
export function aggregateActionState(steps, status) {
  const receipt = (s) => s?.receipt === 'ok';
  const executed = (steps ?? []).filter((s) => isSideEffect(s?.op) && receipt(s)).length;
  if (executed === 0) {
    return (steps ?? []).some((s) => s?.status === 'dispatched-unknown') ? 'dispatched-unknown' : 'not-executed';
  }
  if (status === 'done') return 'executed';
  if ((steps ?? []).some((s) => s?.status === 'dispatched-unknown')) return 'dispatched-unknown';
  return 'partially-executed';
}

/**
 * 同目标无效点击识别（0.2.2 复盘批次，task-1-mucq6hjn 实录）：决策端无记忆，
 * 对「点了没反应」的控件只会机械重点——同一排序项连点 5 次、搜索键连点 3 次，
 * 页面内容摘要一字未变。规则：CLICK 同目标且当前快照摘要与上一次派发时完全
 * 相同 → repeats 累加；换目标、换操作或页面有变化 → 清零（翻页/加载更多的
 * 合法连点不受影响）。调用方在 repeats ≥ 1（同目标第 2 次无效点击派发【前】）
 * 停段。边界：开关型控件每点一次摘要就翻转，本规则不拦——那类信号由决策
 * state 的「最近操作」摘要提示模型自行换路。
 */
export function nextClickRepeat(prev, { op, target, digest }) {
  if (op !== 'CLICK' || target == null) return { target: null, digest: null, repeats: 0 };
  if (prev && prev.target === target && prev.digest === digest) {
    return { target, digest, repeats: (prev.repeats ?? 0) + 1 };
  }
  return { target, digest, repeats: 0 };
}

/**
 * 决策端错误分类（R-05/R-03）：把 jev-client 的错误文案分成结构化 kind，
 * 供失败现场给出「下一步怎么办」——认证类直接指向兜底、不鼓励原样重试。
 */
export function classifyJevError(message) {
  const text = String(message ?? '');
  if (/未配置/.test(text)) return 'auth';
  if (/HTTP 40[13]\b/.test(text)) return 'auth';
  if (/HTTP 429\b/.test(text)) return 'rate-limit';
  if (/HTTP [45]\d\d\b/.test(text)) return /HTTP 5\d\d\b/.test(text) ? 'server' : 'bad-request';
  if (/请求失败|超时|abort/i.test(text)) return 'network';
  return 'unknown';
}

/** 分类对应的模型可见建议（工具面文案，保持与指引一致的兜底语义）。 */
export const JEV_ERROR_ADVICE = {
  auth: '决策端鉴权失败（Key 或模型 ID 问题）：本子目标请直接改用 browser_click/browser_type 操作，不要重试 browser_act，直到 Key/模型修复。',
  'rate-limit': '决策端限流：可稍后再试 browser_act，或本子目标直接改用 browser_click/browser_type。',
  server: '决策端服务出错：可稍后再试一次，或改用 browser_click/browser_type。',
  'bad-request': '决策端拒绝了请求（参数或状态不合规）：调整子目标表述后再试，或改用 browser_click/browser_type。',
  network: '连不上决策端：检查网络后再试，或改用 browser_click/browser_type。',
  unknown: '决策端返回未知错误：换思路拆子目标再试，或改用 browser_click/browser_type。',
};
