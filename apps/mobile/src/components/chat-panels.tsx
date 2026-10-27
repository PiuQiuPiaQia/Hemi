import {ChevronRight, Cloud, ScanLine} from 'lucide-react';
import {Sheet} from './dialog';

export function SettingsPanel({botName, offline, onClose, onExit, onLicenses, onMemory, returnFocus}: {botName: string; offline: boolean; returnFocus?: HTMLElement | null; onClose(): void; onExit(): void; onLicenses(): void; onMemory?(): void}) {
  return <Sheet returnFocus={returnFocus} title="Bot 连接" onClose={onClose}>
    <div className="bot-identity"><Cloud size={24}/><span><strong>{botName}</strong><small>{offline ? '连接已断开' : '已连接'}</small></span></div>
    {onMemory && <button type="button" className="selection-row" onClick={onMemory} disabled={offline}><span>共享记忆<small>查看这个 Bot 的记忆、日志与待办</small></span><ChevronRight size={16}/></button>}
    <button type="button" className="selection-row" disabled><ScanLine size={18}/><span>连接新设备<small>在 PC 的 Bot 设置中生成配对码</small></span></button>
    <button type="button" className="selection-row" disabled><span>已连接设备<small>在 PC 上管理和撤销设备访问</small></span></button>
    <button type="button" className="selection-row" onClick={onLicenses}><span>开源许可</span><ChevronRight size={16}/></button>
    <button type="button" className="selection-row" onClick={onExit}><span>断开 Bot 连接</span><ChevronRight size={16}/></button>
  </Sheet>;
}
