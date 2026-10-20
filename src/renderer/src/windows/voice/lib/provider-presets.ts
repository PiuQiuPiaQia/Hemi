import type {
  ModelEntryView,
  ModelProfilesDirectory,
  ModelProviderSaveInput,
  ModelProviderView,
  ThinkingLevel,
} from '@/shared/types';

/**
 * 037 模型页 v2：服务商预设（静态数据）＋页面用到的纯函数。
 *
 * 现有 IPC 没有「从接口拉型号列表」的能力（surfaces 稿「模型页 v2 对实现的要求」），
 * 添加服务商时可勾选的型号来自这里的常用清单，「其他型号」手填兜底；
 * 粘贴 Key 后的自动测试走 testModelProfile（不带 modelKey＝显式三项探活）。
 * 本文件只有类型导入，node --test 可直接加载。
 */

export type PresetModel = {
  id: string;
  /** 能看图（勾选时 supportsVision=true）。 */
  vision?: boolean;
  /** 添加页默认勾上。 */
  pick?: boolean;
};

export type ProviderPreset = {
  id: string;
  name: string;
  /** 图块上的 1–2 个字。 */
  tile: string;
  /** 网格里名称下面的一行小字。 */
  sub: string;
  baseUrl: string;
  /** 获取 Key 的页面（空＝不需要）。 */
  keyUrl: string;
  /** 「去 X 获取」里的 X。 */
  keySite: string;
  /** 不需要 Key（本地服务）：测试与保存时用占位 Key。 */
  keyless?: boolean;
  models: PresetModel[];
};

/** 本地服务不校验 Key，但探活与回合解析都要求非空——用这个占位。 */
export const KEYLESS_PLACEHOLDER_KEY = 'ollama';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tile: 'DS',
    sub: 'deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keySite: 'DeepSeek',
    models: [{ id: 'deepseek-chat', pick: true }, { id: 'deepseek-reasoner' }],
  },
  {
    id: 'qwen',
    name: '通义千问',
    tile: '通',
    sub: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    keySite: '阿里云',
    models: [
      { id: 'qwen-max', pick: true },
      { id: 'qwen-vl-max', vision: true, pick: true },
      { id: 'qwen-plus' },
      { id: 'qwen-turbo' },
      { id: 'qwen-long' },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    tile: 'K',
    sub: 'moonshot.cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keySite: 'Moonshot',
    models: [
      { id: 'kimi-k2-turbo-preview', pick: true },
      { id: 'kimi-latest', vision: true },
      { id: 'moonshot-v1-32k' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    tile: '智',
    sub: 'bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keySite: '智谱',
    models: [
      { id: 'glm-4.5', pick: true },
      { id: 'glm-4.5v', vision: true },
      { id: 'glm-4.5-air' },
      { id: 'glm-4-flash' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    tile: 'AI',
    sub: 'openai.com',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySite: 'OpenAI',
    models: [
      { id: 'gpt-4.1', vision: true, pick: true },
      { id: 'gpt-4.1-mini', vision: true },
      { id: 'gpt-4o', vision: true },
      { id: 'o4-mini', vision: true },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tile: 'OR',
    sub: '多家模型',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keySite: 'OpenRouter',
    models: [
      { id: 'deepseek/deepseek-chat', pick: true },
      { id: 'openai/gpt-4.1', vision: true },
      { id: 'google/gemini-2.5-flash', vision: true },
      { id: 'anthropic/claude-sonnet-4', vision: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    tile: '本',
    sub: '无需 Key',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyUrl: '',
    keySite: '',
    keyless: true,
    models: [{ id: 'qwen2.5:14b', pick: true }, { id: 'qwen2.5vl:7b', vision: true }, { id: 'llama3.1:8b' }],
  },
  {
    id: 'custom',
    name: '自定义',
    tile: '+',
    sub: '任意兼容接口',
    baseUrl: '',
    keyUrl: '',
    keySite: '',
    models: [],
  },
];

export function presetById(id: string | null | undefined): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 接口地址的主机部分（含端口）；不是 URL 时去掉协议原样返回。 */
export function hostOf(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  }
}

/** 按接口地址主机认出预设（自定义不参与匹配）。 */
export function matchPreset(baseUrl: string): ProviderPreset | null {
  const host = hostOf(baseUrl).toLowerCase();
  if (!host) return null;
  return (
    PROVIDER_PRESETS.find((preset) => preset.baseUrl && hostOf(preset.baseUrl).toLowerCase() === host) ??
    (/^(127\.0\.0\.1|localhost):11434$/.test(host) ? presetById('ollama') : null)
  );
}

/** 供应商图块上的字：认得出预设用预设的，否则取名称首字（拉丁字母取前两个大写）。 */
export function providerTile(name: string, baseUrl: string): string {
  const preset = matchPreset(baseUrl);
  if (preset) return preset.tile;
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const latin = trimmed.match(/^[A-Za-z0-9]{1,2}/);
  return latin ? latin[0].toUpperCase() : Array.from(trimmed)[0];
}

/** 本地服务（不需要 Key）：预设标记或回环地址。 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const host = hostOf(baseUrl).toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

/** 「正在使用 · 思考强度」分段：稿里的 关 / 自动 / 低 / 中 / 高。 */
export const THINKING_SEGMENTS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'default', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function thinkingLabel(level: ThinkingLevel): string {
  return THINKING_SEGMENTS.find((item) => item.value === level)?.label ?? '自动';
}

export type ModelRef = { provider: ModelProviderView; model: ModelEntryView };

/** 默认（对话）模型：defaultModelId 优先，其次 isDefault 标记，最后第一个。 */
export function findDefaultModel(directory: ModelProfilesDirectory | null): ModelRef | null {
  if (!directory) return null;
  let first: ModelRef | null = null;
  let flagged: ModelRef | null = null;
  for (const provider of directory.providers) {
    for (const model of provider.models) {
      const ref = { provider, model };
      if (directory.defaultModelId && model.modelKey === directory.defaultModelId) return ref;
      if (!flagged && model.isDefault) flagged = ref;
      if (!first) first = ref;
    }
  }
  return flagged ?? first;
}


/** 视图 → 保存输入（供应商整体提交；Key 只写不读，空＝沿用已存；api 缺省沿已存）。 */
export function providerSaveInput(
  provider: Pick<ModelProviderView, 'id' | 'name' | 'baseUrl' | 'models' | 'api'>,
  patch: { name?: string; baseUrl?: string; apiKey?: string; api?: ModelProviderView['api']; models?: ModelEntryView[] } = {},
): ModelProviderSaveInput {
  const models = patch.models ?? provider.models;
  return {
    id: provider.id,
    name: (patch.name ?? provider.name).trim(),
    baseUrl: (patch.baseUrl ?? provider.baseUrl).trim(),
    api: patch.api ?? provider.api,
    apiKey: patch.apiKey?.trim() || undefined,
    models: models
      .filter((model) => model.model.trim())
      .map((model) => ({
        id: model.id || undefined,
        model: model.model.trim(),
        thinkingLevel: model.thinkingLevel,
        supportsVision: model.supportsVision,
        visionModel: model.visionModel.trim() || undefined,
      })),
  };
}

/** 新加型号的本地占位条目（保存回读后换成主进程分配的 id/modelKey）。 */
export function draftModelEntry(providerId: string, model: string, vision = false): ModelEntryView {
  const id = `m-draft-${model.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return {
    id: '',
    modelKey: `${providerId}/${id}`,
    model,
    thinkingLevel: 'default',
    supportsVision: vision,
    visionModel: '',
    isDefault: false,
  };
}

/** 预设里这个型号能看图吗（手填的型号按名字猜：含 vl / vision / 4o / 4.1 / gemini 等）。 */
export function guessVision(preset: ProviderPreset | null, model: string): boolean {
  const known = preset?.models.find((item) => item.id === model);
  if (known) return known.vision === true;
  return /(^|[-/:._])(vl|vision)([-/:._]|$)|-vl-|4\.5v|gpt-4o|gpt-4\.1|gemini|claude/i.test(model);
}

/** 新服务商的名称：同名已存在时加序号。 */
export function uniqueProviderName(base: string, existing: string[]): string {
  const name = base.trim() || '新服务商';
  if (!existing.includes(name)) return name;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name} ${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${name} ${Date.now().toString(36)}`;
}

/** 某型号是否正被当作看图模型（056 起看图模型单独配置：目录的 visionModelKey）。 */
export function modelUsage(directory: ModelProfilesDirectory | null, model: ModelEntryView): 'vision' | null {
  return directory?.visionModelKey && directory.visionModelKey === model.modelKey ? 'vision' : null;
}
