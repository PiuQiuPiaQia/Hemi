import {useRef, useState, type ReactNode} from 'react';
import {Sparkles} from 'lucide-react';
import {SelectionSurface, useControlDisclosure, type ControlDisclosureProps} from '@hemi/ui';
import {ComposerControlButton, type ComposerControlLayout} from './composer-control-button.js';
import {ModelOptions, type ModelOption} from './model-options.js';

export function ModelSelectorControl({models, selected, onSelect, layout = 'desktop', automatic = false, text, label, title, showTrigger = true, disabled = false, saving = false, offline = false, error = '', emptyMessage = 'Bot 尚未提供可用模型。', returnFocus, onOpen, children, ...disclosureProps}: ControlDisclosureProps & {
  models: ModelOption[];
  selected: string | null;
  onSelect(id: string): void | boolean | Promise<void | boolean>;
  layout?: ComposerControlLayout;
  automatic?: boolean;
  text?: string;
  label?: string;
  title?: string;
  /** Hide the built-in trigger when a controlled touch sheet is opened elsewhere. */
  showTrigger?: boolean;
  disabled?: boolean;
  saving?: boolean;
  offline?: boolean;
  error?: string;
  emptyMessage?: string;
  returnFocus?: HTMLElement | null;
  onOpen?(): void;
  children?(close: () => void): ReactNode;
}) {
  const disclosure = useControlDisclosure(disclosureProps), anchorRef = useRef<HTMLButtonElement>(null);
  const [localError, setLocalError] = useState('');
  const touch = layout === 'touch';
  const name = text ?? models.find(model => model.id === selected)?.name ?? selected ?? '模型';
  const select = async (id: string) => {
    try {if (await onSelect(id) !== false) disclosure.close();}
    catch (reason) {setLocalError(reason instanceof Error ? reason.message : '模型保存失败，请重试。');}
  };
  const content = <>
    {showTrigger ? <ComposerControlButton kind="model" layout={layout} icon={automatic && !touch ? <Sparkles aria-hidden="true"/> : undefined} ref={anchorRef} text={name} label={label ?? `切换模型：${name}`} title={title} disabled={disabled || saving || offline} aria-haspopup={touch ? 'dialog' : 'menu'} aria-expanded={disclosure.open} onClick={() => {if (!disclosure.open) {setLocalError(''); onOpen?.();} disclosure.toggle();}}/> : null}
    <SelectionSurface presentation={touch ? 'sheet' : 'menu'} title="选择模型" open={disclosure.open} onClose={disclosure.close} anchorRef={anchorRef} returnFocus={returnFocus} menuProps={{className:'h37-model-menu',autoFocusFirst:false}}>
      {error || localError ? <p className="workspace-error" role="alert">{error || localError}</p> : null}
      {touch && offline ? <p className="field-note" role="status">恢复 Bot 连接后可切换模型。</p> : null}
      {children ? children(disclosure.close) : <ModelOptions models={models} selected={selected} onSelect={id => {void select(id);}} disabled={disabled || saving || offline} presentation={touch ? 'sheet' : 'menu'}/>}
      {!children && !models.length ? <p className="body-copy">{emptyMessage}</p> : null}
      {saving ? <p className="field-note" role="status">正在保存…</p> : null}
    </SelectionSurface>
  </>;
  return touch ? content : <div className="h24-model-select">{content}</div>;
}
