import { publicModel, fail } from './storage.mjs';

const FIELDS = { name: '供应商', model: '型号', baseUrl: '接口地址', api: '协议', thinkingLevel: '思考强度', thinkingFormat: '思考格式', supportsVision: '图片能力' };
const label = model => model ? `${model.name} · ${model.model}` : '未配置';

/** Public differences only. Credentials stay in the desktop profile store. */
export function modelSyncChanges(local, cache) {
  const remote = new Map(cache.models.map(model => [model.key, model]));
  const configs = new Map(local.models.map(model => [model.modelKey, model]));
  const changes = [];
  const accounts = new Set();
  for (const candidate of local.candidates) {
    if (candidate.oauthProvider) {
      if (accounts.has(candidate.oauthProvider)) continue;
      accounts.add(candidate.oauthProvider);
      const connected = cache.oauthAccounts?.some(account => account.provider === candidate.oauthProvider && account.connected);
      changes.push({ id: 'account:' + candidate.oauthProvider, kind: 'account', action: connected ? 'update' : 'add',
        oauthProvider: candidate.oauthProvider, title: candidate.provider,
        before: connected ? 'Bot 已登录' : 'Bot 尚未登录', after: '为 Bot 单独授权',
        details: ['本机登录保持不变；Bot 独立保存凭据并续期'], canSync: false, reason: '' });
      continue;
    }
    const before = remote.get(candidate.key), config = configs.get(candidate.key);
    if (before?.revision === candidate.revision && candidate.canSync) continue;
    const after = config ? publicModel(config, candidate.revision) : null;
    const details = before && after ? Object.entries(FIELDS).filter(([field]) => before[field] !== after[field])
      .map(([field, name]) => `${name}：${String(before[field] ?? '默认')} → ${String(after[field] ?? '默认')}`) : [];
    if (config) details.push(before && !details.length ? '连接凭据或其它模型参数有变化；使用本机保存的 API Key' : '使用本机保存的 API Key');
    changes.push({ id: 'model:' + candidate.key, kind: 'model', action: before ? 'update' : 'add',
      modelKey: candidate.key, title: `${candidate.provider} · ${candidate.name}`,
      before: before ? label(before) : 'Bot 尚未添加', after: after ? label(after) : candidate.reason,
      details, canSync: candidate.canSync, reason: candidate.reason });
  }
  const localKeys = new Set(local.candidates.map(model => model.key));
  for (const model of cache.models) if (!model.oauthProvider && !localKeys.has(model.key)) changes.push({
    id: 'model:' + model.key, kind: 'model', action: 'remove', modelKey: model.key,
    title: label(model), before: label(model), after: '从 Bot 移除',
    details: ['仅在 Bot 中存在；勾选才会移除'], canSync: true, reason: '',
  });
  return changes;
}

export function selectedModelChanges(changes, selected, local) {
  if (!Array.isArray(selected) || !selected.length || selected.length > 1000) fail('请勾选要同步的模型。');
  const selectedIds = new Set(selected), entries = [...selectedIds].map(id => changes.find(change => change.id === id));
  if (entries.some(change => change?.kind !== 'model' || !change.canSync)) fail('所选差异已不可用，请重新对比。', 'conflict');
  const keys = new Set(entries.filter(entry => entry.kind === 'model' && entry.action !== 'remove').map(entry => entry.modelKey));
  const models = local.models.filter(model => keys.has(model.modelKey));
  const removeKeys = entries.filter(entry => entry.kind === 'model' && entry.action === 'remove').map(entry => entry.modelKey);
  return { models, removeKeys };
}
