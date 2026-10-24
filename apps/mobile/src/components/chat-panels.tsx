import {Check, ChevronRight, Cloud, ScanLine} from 'lucide-react';
import type {MobileConversation, MobileModel, MobileThinking} from '../workspace';
import {Sheet} from './dialog';

export const thinkingOptions: Array<{value: MobileThinking; label: string; hint: string}> = [
  {value:'default',label:'自动',hint:'使用模型默认强度'},
  {value:'off',label:'关闭',hint:'尽量直接回答'},
  {value:'low',label:'低',hint:'较快响应'},
  {value:'medium',label:'中',hint:'平衡速度与推理'},
  {value:'high',label:'高',hint:'更多推理，耗时可能更长'},
];

export function ModelPanel({item, models, saving, offline, error, onClose, onSelect, returnFocus}: {item: MobileConversation; models: MobileModel[]; saving: boolean; offline: boolean; error?: string; returnFocus?: HTMLElement | null; onClose(): void; onSelect(id: string): void}) {
  return <Sheet returnFocus={returnFocus} title="选择模型" onClose={onClose}>
    {error?<p className="workspace-error" role="alert">{error}</p>:null}
    {offline?<p className="field-note" role="status">恢复 Bot 连接后可切换模型。</p>:null}
    {models.map(model => <button type="button" className="selection-row" aria-pressed={item.model===model.id} disabled={saving||offline} key={model.id} onClick={() => onSelect(model.id)}><span className="model-mark">{model.name.slice(0, 1)}</span><span>{model.name}{model.description ? <small>{model.description}</small> : null}</span>{item.model === model.id ? <Check size={18}/> : null}</button>)}
    {!models.length ? <p className="body-copy">Bot 尚未提供可用模型。</p> : null}
    {saving ? <p className="field-note" role="status">正在保存…</p> : null}
  </Sheet>;
}
export function ThinkingPanel({value, saving, offline, error, onSelect, onClose, returnFocus}: {value: MobileThinking; saving: boolean; offline: boolean; error?: string; onSelect(value: MobileThinking): void; onClose(): void; returnFocus?: HTMLElement | null}) {
  return <Sheet returnFocus={returnFocus} title="思考强度" onClose={onClose}>
    {error?<p className="workspace-error" role="alert">{error}</p>:null}
    {offline?<p className="field-note" role="status">恢复 Bot 连接后可调整思考强度。</p>:null}
    {thinkingOptions.map(option=><button type="button" key={option.value} className="selection-row" aria-pressed={option.value===value} disabled={saving||offline} onClick={()=>onSelect(option.value)}><span>{option.label}<small>{option.hint}</small></span>{option.value===value?<Check size={18}/>:null}</button>)}
    {saving?<p className="field-note" role="status">正在保存…</p>:null}
  </Sheet>;
}
export function SettingsPanel({botName, offline, onClose, onExit, onLicenses, returnFocus}: {botName: string; offline: boolean; returnFocus?: HTMLElement | null; onClose(): void; onExit(): void; onLicenses(): void}) {
  return <Sheet returnFocus={returnFocus} title="Bot 连接" onClose={onClose}>
    <div className="bot-identity"><Cloud size={24}/><span><strong>{botName}</strong><small>{offline ? '连接已断开' : '已连接'}</small></span></div>
    <button type="button" className="selection-row" disabled><ScanLine size={18}/><span>连接新设备<small>在 PC 的 Bot 设置中生成配对码</small></span></button>
    <button type="button" className="selection-row" disabled><span>已连接设备<small>在 PC 上管理和撤销设备访问</small></span></button>
    <button type="button" className="selection-row" onClick={onLicenses}><span>开源许可</span><ChevronRight size={16}/></button>
    <button type="button" className="selection-row" onClick={onExit}><span>断开 Bot 连接</span><ChevronRight size={16}/></button>
  </Sheet>;
}
