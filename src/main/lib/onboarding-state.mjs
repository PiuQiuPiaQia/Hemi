// 032 冷启动引导状态机：主进程唯一的引导进度权威。
//
// 状态存 userData/onboarding.json（临时文件 + rename 原子写；进程内单飞初始化）。
// 只存非敏感值（version/phase/step/permissionChoice/时间戳）——Key、URL、模型
// 配置一律以各自的存储为权威，这里按需读取判定：
// - 语音服务为可选能力，快照报告密钥是否已保存，但不阻塞文字使用；
// - 模型门槛＝031 配置组目录存在默认组，且接口地址、型号与已加密保存的 Key 完整
//   （依赖注入的 defaultModelComplete 由 IPC 层用目录视图实现，环境覆盖不参与）。
//
// 进行中（in_progress）与完成（complete）分开持久化：完成版本只在完成屏
// 「开始使用」写入，之后不因配置失效回退。读取时把进度与真实配置对齐——
// 配置被删只退步，不进步。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ONBOARDING_VERSION = 2;
/** 主流程：欢迎 → 模型 → 可选能力 → 完成；麦克风/ASR 是可选能力的子页。 */
export const ONBOARDING_STEPS = ['welcome', 'model', 'capabilities', 'microphone', 'asr', 'done'];
const NEXT_STEPS = {
  welcome: ['model'],
  model: ['welcome', 'capabilities'],
  capabilities: ['model', 'microphone', 'done'],
  microphone: ['capabilities', 'asr'],
  asr: ['microphone', 'capabilities'],
  done: ['capabilities'],
};
const PERMISSION_CHOICES = ['pending', 'granted', 'skipped'];

export function stepIndexOf(step) {
  return ONBOARDING_STEPS.indexOf(step);
}

function normalizeSnapshot(raw) {
  const phase = raw?.phase === 'complete' ? 'complete' : 'in_progress';
  let step = ONBOARDING_STEPS.includes(raw?.step)
    ? raw.step
    : (phase === 'complete' ? 'done' : 'welcome');
  // 旧引导尚未完成时先接回模型配置；保留已存模型/语音密钥与权限选择。
  if (phase !== 'complete' && raw?.version !== ONBOARDING_VERSION && step !== 'welcome') step = 'model';
  const permissionChoice = PERMISSION_CHOICES.includes(raw?.permissionChoice)
    ? raw.permissionChoice
    : 'pending';
  return {
    version: ONBOARDING_VERSION,
    phase,
    step,
    permissionChoice,
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0,
    completedAt: phase === 'complete' && Number.isFinite(raw?.completedAt)
      ? raw.completedAt
      : null,
  };
}

/** 进行中的进度与真实配置对齐：配置缺失退回相应配置步（只退不进）。 */
export function alignStep(snapshot, { modelComplete }) {
  if (snapshot.phase === 'complete') return snapshot;
  let index = stepIndexOf(snapshot.step);
  if (index < 0) index = 0;
  if (!modelComplete && index > stepIndexOf('model')) index = stepIndexOf('model');
  if (ONBOARDING_STEPS[index] === snapshot.step) return snapshot;
  return { ...snapshot, step: ONBOARDING_STEPS[index] };
}

/**
 * 引导状态工厂（依赖全注入，离线可测）。
 * @param {object} deps
 * @param {string | (() => string)} deps.filePath             onboarding.json 路径（函数＝惰性求值：
 *   主进程在 app.setPath('userData') 之前就会加载本模块，提前取路径会写错目录）
 * @param {() => Promise<boolean>} deps.hasPersistedAsrKey      语音服务密钥已持久保存
 * @param {() => Promise<boolean>} deps.defaultModelComplete    默认模型组字段完整且 Key 已加密保存
 */
export function createOnboardingStore({
  filePath,
  readFile: readFileImpl = readFile,
  writeFile: writeFileImpl = writeFile,
  rename: renameImpl = rename,
  mkdir: mkdirImpl = mkdir,
  now = () => Date.now(),
  hasPersistedAsrKey,
  defaultModelComplete,
  log = null,
} = {}) {
  const pathOf = () => (typeof filePath === 'function' ? filePath() : filePath);
  let snapshot = null;
  let initInFlight = null;

  async function persist(next) {
    const target = pathOf();
    const temp = `${target}.tmp`;
    await mkdirImpl(path.dirname(target), { recursive: true });
    await writeFileImpl(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameImpl(temp, target);
    snapshot = next;
  }

  async function readGates() {
    const [asrSaved, modelComplete] = await Promise.all([
      hasPersistedAsrKey().catch(() => false),
      defaultModelComplete().catch(() => false),
    ]);
    return { asrSaved, modelComplete };
  }

  /**
   * 首次判定只做一次（进程内单飞）：
   * - 已有状态按状态走（损坏/缺失的 onboarding.json 视为无状态重建）；
   * - 无状态先写 in_progress/welcome，再展示欢迎屏。
   */
  async function ensureInitialized() {
    if (snapshot) return snapshot;
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      let raw = null;
      try {
        raw = JSON.parse(await readFileImpl(pathOf(), 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          log?.warn(`引导状态文件不可读（${error?.message ?? error}），按无状态重建`);
        }
      }
      if (raw && (raw.phase === 'complete' || raw.phase === 'in_progress')) {
        snapshot = normalizeSnapshot(raw);
        return snapshot;
      }
      snapshot = normalizeSnapshot({ phase: 'in_progress', step: 'welcome', permissionChoice: 'pending', updatedAt: now() });
      await persist(snapshot);
      return snapshot;
    })();
    try {
      return await initInFlight;
    } finally {
      initInFlight = null;
    }
  }

  /** 完整状态（渲染层用）：对齐后的进度 + 两项配置的实时满足情况。 */
  async function getState() {
    await ensureInitialized();
    const gates = await readGates();
    const aligned = alignStep(snapshot, gates);
    if (aligned !== snapshot) await persist({ ...aligned, updatedAt: now() });
    return {
      version: aligned.version,
      phase: aligned.phase,
      step: aligned.step,
      permissionChoice: aligned.permissionChoice,
      asrSaved: gates.asrSaved,
      modelComplete: gates.modelComplete,
      updatedAt: aligned.updatedAt,
    };
  }

  /**
   * 按主流程与可选子页导航；模型是唯一配置门槛。
   * 权限选择随麦克风步前进落账（granted/skipped），其余时候仅接受就地更新。
   */
  async function advance({ to, permissionChoice } = {}) {
    await ensureInitialized();
    if (snapshot.phase === 'complete') {
      return { ok: false, message: '引导已完成，无需继续' };
    }
    if (!ONBOARDING_STEPS.includes(to)) {
      return { ok: false, message: '未知的引导步骤' };
    }
    const gates = await readGates();
    const from = alignStep(snapshot, gates).step;
    const toIndex = stepIndexOf(to);
    if (to !== from && !NEXT_STEPS[from]?.includes(to)) {
      return { ok: false, message: '请先完成当前引导步骤' };
    }
    const choice = PERMISSION_CHOICES.includes(permissionChoice)
      ? permissionChoice
      : snapshot.permissionChoice;
    if (from === 'microphone' && to === 'asr' && choice !== 'granted') {
      return { ok: false, message: '允许麦克风后可继续配置语音，或选择暂时跳过' };
    }
    if (toIndex > stepIndexOf('model') && !gates.modelComplete) {
      return { ok: false, message: '先连接一个模型' };
    }
    await persist({ ...snapshot, step: to, permissionChoice: choice, updatedAt: now() });
    return { ok: true, state: await getState() };
  }

  /** 完成屏「开始使用」：模型就绪即可完成，语音配置可留空（幂等）。 */
  async function complete() {
    await ensureInitialized();
    if (snapshot.phase === 'complete') return { ok: true, state: await getState() };
    const gates = await readGates();
    if (snapshot.step !== 'done') return { ok: false, message: '请先完成当前引导步骤' };
    if (!gates.modelComplete) return { ok: false, message: '主脑模型还没有保存完整' };
    const stamped = now();
    await persist({
      ...snapshot,
      phase: 'complete',
      step: 'done',
      updatedAt: stamped,
      completedAt: stamped,
    });
    return { ok: true, state: await getState() };
  }

  return {
    ensureInitialized,
    getState,
    advance,
    complete,
    /** 同步快照（悬浮球/全局快捷键门控用）；未初始化按「进行中」保守处理。 */
    isInProgress() {
      return snapshot ? snapshot.phase === 'in_progress' : true;
    },
  };
}
