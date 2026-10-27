import { ExternalLink, Globe, Lock, Monitor } from 'lucide-react';
import { MODEL_CATEGORIES, type ModelCategory } from '@shared/model-categories.mjs';

const DETAILS = {
  subscription: { icon: ExternalLink, description: '登录账号，使用订阅模型与额度' },
  newapi: { icon: Globe, description: '登录 New API 站点并导入模型' },
  api: { icon: Lock, description: '填写接口地址、API Key 和型号' },
  local: { icon: Monitor, description: '对比并选择要同步的本机配置' },
};

export function ModelConnectionMethods({ value, onChange, bot = false, disabled = false }: {
  value: ModelCategory; onChange(value: ModelCategory): void; bot?: boolean; disabled?: boolean;
}) {
  const categories = MODEL_CATEGORIES.filter(category => bot || category.id !== 'local');
  return <div className="h47n-methods" data-bot={bot ? 'true' : undefined} role="radiogroup" aria-label="模型分类">
    {categories.map((category, index) => {
      const { icon: Icon, description } = DETAILS[category.id];
      return <button type="button" role="radio" key={category.id} data-method={category.id} tabIndex={value === category.id ? 0 : -1} disabled={disabled} aria-checked={value === category.id}
        onKeyDown={event => {
          if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
          event.preventDefault();
          const next = categories[event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? categories.length - 1 : 1)) % categories.length];
          onChange(next.id); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-method="${next.id}"]`)?.focus();
        }}
        className="h47n-method" data-on={value === category.id ? 'true' : undefined} onClick={() => onChange(category.id)}>
        <span className="h37-tile h37m-tile-sm" data-tone={value === category.id ? 'g' : undefined} aria-hidden><Icon size={16} /></span>
        <span className="h47n-method-text"><b>{category.label}</b><span>{description}</span></span>
      </button>;
    })}
  </div>;
}
