import {useRef, useState} from 'react';
import {Brain} from 'lucide-react';
import {SelectionSurface, useControlDisclosure, type ControlDisclosureProps} from '@hemi/ui';
import {THINKING_LEVEL_OPTIONS, ThinkingOptions} from './thinking-options.js';
import {ComposerControlButton, type ComposerControlLayout} from './composer-control-button.js';
import type {ThinkingLevel} from '../types/presentation.js';
const LEVEL_TONES: Record<ThinkingLevel, string> = {default:'var(--muted)',off:'var(--faint)',low:'var(--g-500)',medium:'var(--g-600)',high:'var(--warn)'};
/** The same selector owns desktop menu and touch sheet behavior; persistence stays with its host. */
export function ThinkingLevelStrip({level, onChange, layout = 'desktop', disabled = false, saving = false, offline = false, error = '', returnFocus, ...disclosureProps}: ControlDisclosureProps & {
  level: ThinkingLevel;
  onChange(level: ThinkingLevel): void | boolean | Promise<void | boolean>;
  layout?: ComposerControlLayout;
  disabled?: boolean;
  saving?: boolean;
  offline?: boolean;
  error?: string;
  returnFocus?: HTMLElement | null;
}) {
  const disclosure = useControlDisclosure(disclosureProps), anchorRef = useRef<HTMLButtonElement>(null);
  const [localError, setLocalError] = useState('');
  const touch = layout === 'touch', current = THINKING_LEVEL_OPTIONS.find(option => option.value === level) ?? THINKING_LEVEL_OPTIONS[0];
  const select = async (next: ThinkingLevel) => {
    try {if ((!touch && next === level) || await onChange(next) !== false) disclosure.close();}
    catch (reason) {setLocalError(reason instanceof Error ? reason.message : '思考强度保存失败，请重试。');}
  };
  const content = <>
    <ComposerControlButton kind="thinking" layout={layout} ref={anchorRef} label={touch ? `思考强度：${current.touchLabel}` : `思考强度：${current.label}${level === 'default' ? '（自动）' : ''}`} text={touch ? current.touchLabel : `思考${current.label}`} title={touch ? undefined : `思考强度：${current.label}${level === 'default' ? '（自动 · 厂商中档）' : ''}。全局档，按各供应商的等级映射生效`} icon={<Brain size={touch ? 16 : undefined} style={touch ? undefined : {color: LEVEL_TONES[level] ?? LEVEL_TONES.default}} aria-hidden="true"/>} data-compact={!touch && level === 'default' ? 'true' : undefined} aria-haspopup={touch ? 'dialog' : 'menu'} aria-expanded={disclosure.open} disabled={disabled || saving || offline} onClick={() => {setLocalError(''); disclosure.toggle();}}/>
    <SelectionSurface presentation={touch ? 'sheet' : 'menu'} title="思考强度" open={disclosure.open} onClose={disclosure.close} anchorRef={anchorRef} returnFocus={returnFocus} menuProps={{className:'h37-thinking-menu'}}>
      {error || localError ? <p className="workspace-error" role="alert">{error || localError}</p> : null}
      {touch && offline ? <p className="field-note" role="status">恢复 Bot 连接后可调整思考强度。</p> : null}
      {!touch ? <div style={{fontSize:'var(--fs-12)',color:'var(--faint)',padding:'var(--sp-4) var(--sp-10)',marginBottom:'var(--sp-2)'}}>思考强度 · 当前：{current.label}</div> : null}
      <ThinkingOptions value={level} onSelect={next => {void select(next);}} disabled={disabled || saving || offline} presentation={touch ? 'sheet' : 'menu'}/>
      {saving ? <p className="field-note" role="status">正在保存…</p> : null}
    </SelectionSurface>
  </>;
  return touch ? content : <div className="relative">{content}</div>;
}
