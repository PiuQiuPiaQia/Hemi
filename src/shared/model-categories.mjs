export const MODEL_CATEGORIES = Object.freeze([
  { id: 'subscription', label: '订阅' },
  { id: 'newapi', label: 'New API' },
  { id: 'api', label: 'API 配置' },
  { id: 'local', label: '本机配置' },
]);

export function modelCategory(provider, bot = false) {
  if (bot && provider.source === 'local') return 'local';
  if (provider.oauthProvider) return 'subscription';
  // mpi-* is the existing New API importer's deterministic provider identity.
  if (provider.configuration === 'newapi' || /^mpi-/.test(provider.id ?? '')) return 'newapi';
  return 'api';
}

export function groupModelProviders(providers, bot = false) {
  return MODEL_CATEGORIES.filter(category => bot || category.id !== 'local').map(category => ({
    ...category, label: category.id === 'local' ? '从本机同步的模型' : category.label,
    providers: providers.filter(provider => modelCategory(provider, bot) === category.id),
  }));
}
