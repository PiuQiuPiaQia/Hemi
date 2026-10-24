import { Check } from 'lucide-react';
import { MenuItem } from '@hemi/ui';
import type { ThinkingLevel } from '../types/presentation.js';
export const THINKING_LEVEL_OPTIONS: Array<{
    value: ThinkingLevel;
    label: string;
    hint: string;
    touchLabel: string;
    touchHint: string;
}> = [
    { value: 'default', label: '默认', hint: '厂商中档思考，适合日常', touchLabel: '自动', touchHint: '使用模型默认强度' },
    { value: 'off', label: '关闭', hint: '不思考，出答案最快', touchLabel: '关闭', touchHint: '尽量直接回答' },
    { value: 'low', label: '低', hint: '少量思考，快问快答', touchLabel: '低', touchHint: '较快响应' },
    { value: 'medium', label: '中', hint: '平衡速度与质量', touchLabel: '中', touchHint: '平衡速度与推理' },
    { value: 'high', label: '高', hint: '想得更周全，等待更久', touchLabel: '高', touchHint: '更多推理，耗时可能更长' },
];
const tones = { default: 'var(--muted)', off: 'var(--faint)', low: 'var(--g-500)', medium: 'var(--g-600)', high: 'var(--warn)' };
export function ThinkingOptions({ value, onSelect, disabled = false, presentation = 'menu' }: {
    value: ThinkingLevel;
    onSelect(value: ThinkingLevel): void;
    disabled?: boolean;
    presentation?: 'menu' | 'sheet';
}) {
    return THINKING_LEVEL_OPTIONS.map(option => presentation === 'sheet' ? <button type="button" key={option.value} className="selection-row" aria-pressed={option.value === value} disabled={disabled} onClick={() => onSelect(option.value)}><span>{option.touchLabel}<small>{option.touchHint}</small></span>{option.value === value ? <Check size={18}/> : null}</button> : <MenuItem key={option.value} role="menuitemradio" disabled={disabled} icon={<span style={{ display: 'block', width: 8, height: 8, borderRadius: '50%', background: tones[option.value], flexShrink: 0 }} aria-hidden="true"/>} label={`${option.label} · ${option.hint}`} checked={option.value === value} onClick={() => onSelect(option.value)}/>);
}
