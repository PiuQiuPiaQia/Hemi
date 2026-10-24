import { Check, Monitor, Server } from 'lucide-react';
export type ModelOption = {
    source?: 'local' | 'cloud';
    id: string;
    name: string;
    description?: string;
    disabledReason?: string;
    unavailableLabel?: string;
};
export function ModelOptions({ models, selected, onSelect, disabled = false, presentation = 'menu' }: {
    models: ModelOption[];
    selected: string | null;
    onSelect(id: string): void;
    disabled?: boolean;
    presentation?: 'menu' | 'sheet';
}) {
    return models.map(model => {
        const active = selected === model.id, blocked = disabled || !!model.disabledReason;
        return <button type="button" key={model.id} role={presentation === 'menu' ? 'menuitemradio' : undefined} aria-checked={presentation === 'menu' ? active : undefined} aria-pressed={presentation === 'sheet' ? active : undefined} className={presentation === 'menu' ? 'h37-menu-item' : 'selection-row'} disabled={blocked} title={model.disabledReason} tabIndex={presentation === 'menu' ? -1 : undefined} onClick={() => onSelect(model.id)}>
      {presentation === 'sheet' ? <span className="model-mark" style={{ flex: 'none' }} title={model.source ? (model.source === 'local' ? '本机配置' : '云端配置') : undefined} aria-label={model.source ? (model.source === 'local' ? '本机配置' : '云端配置') : undefined}>{model.source === 'local' ? <Monitor size={16} aria-hidden="true"/> : model.source === 'cloud' ? <Server size={16} aria-hidden="true"/> : model.name.slice(0, 1)}</span> : model.source ? <span style={{ display: 'inline-flex', flex: 'none' }} title={model.source === 'local' ? '本机配置' : '云端配置'} aria-label={model.source === 'local' ? '本机配置' : '云端配置'}>{model.source === 'local' ? <Monitor size={14} aria-hidden="true"/> : <Server size={14} aria-hidden="true"/>}</span> : null}
      <span style={presentation === 'menu' ? { flex: 1 } : undefined}>{model.name}{presentation === 'sheet' && model.description ? <small>{model.description}</small> : null}</span>
      {presentation === 'menu' && model.description ? <span style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)' }}>{model.description}</span> : null}
      {model.disabledReason && presentation === 'menu' ? <small style={{ fontSize: 'var(--fs-12)', color: 'var(--danger)' }}>{model.unavailableLabel ?? '未配 Key'}</small> : null}
      {active ? <Check size={presentation === 'sheet' ? 18 : 14} style={presentation === 'menu' ? { flexShrink: 0, color: 'var(--body)' } : undefined}/> : null}
    </button>;
    });
}
