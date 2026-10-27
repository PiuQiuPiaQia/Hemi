import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Info, RefreshCw } from 'lucide-react';
import type { AgentEnvironmentSnapshot } from '@/shared/types';
import { Markdown } from '@/shared/markdown';
import { useClipboardCopy } from '@/lib/use-clipboard-copy';
import { InfoPopover } from '@/components/info-popover';

type Props = {
  inspect?: () => Promise<AgentEnvironmentSnapshot>;
  readFile?: (path: string) => Promise<{ path: string; text: string }>;
};
const localInspect = () => window.hemiVoice.inspectAgentEnvironment();
const localRead = (path: string) => window.hemiVoice.readAgentRuntimeFile({ path });
const categories = [
  { id: 'long', label: '长期记忆', matches: (path: string) => path === 'MEMORY.md' },
  { id: 'daily', label: '每日日志', matches: (path: string) => path.startsWith('daily/') },
  { id: 'scratchpad', label: '待办', matches: (path: string) => path === 'SCRATCHPAD.md' },
  { id: 'recovery', label: '恢复记录', matches: (path: string) => path.startsWith('recovery/') },
];

/** View original plugin files; mutations and automatic summaries remain native tools and hooks. */
export function MemorySection({ inspect = localInspect, readFile = localRead }: Props) {
  const [snapshot, setSnapshot] = useState<AgentEnvironmentSnapshot | null>(null);
  const [category, setCategory] = useState('long');
  const [selected, setSelected] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [summaryInfoOpen, setSummaryInfoOpen] = useState(false);
  const epoch = useRef(0);
  const { copy, toastNode } = useClipboardCopy();
  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    setLoading(true); setError(''); setText(null);
    try {
      const next = await inspect();
      if (epoch.current === ticket) { setSnapshot(next); setRevision(value => value + 1); }
    } catch (e) {
      if (epoch.current === ticket) { setSnapshot(null); setError(e instanceof Error ? e.message : '无法读取记忆'); }
    } finally { if (epoch.current === ticket) setLoading(false); }
  }, [inspect]);
  useEffect(() => { setSnapshot(null); void refresh(); return () => { epoch.current++; }; }, [refresh]);
  const group = categories.find(item => item.id === category)!;
  const files = snapshot?.files.filter(file => group.matches(file.path)) ?? [];
  const path = files.some(file => file.path === selected) ? selected : files[0]?.path ?? '';
  const modifiedAt = files.find(file => file.path === path)?.modifiedAt;
  useEffect(() => {
    let active = true;
    setText(null);
    if (path) {
      void readFile(path).then(file => { if (active) setText(file.text); }).catch(e => { if (active) setError(e instanceof Error ? e.message : '文件读取失败'); });
    }
    return () => { active = false; };
  }, [path, modifiedAt, readFile, revision]);

  return <section className="h37-section h-native-memory" aria-label="共享记忆">
    <div className="h-native-memory-toolbar">
    <div className="h37-seg h-native-memory-categories" role="group" aria-label="记忆文件类别">
      {categories.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setSelected(''); setError(''); }}>{item.label}</button>)}
    </div>
      <button type="button" className="h37-btn h37-btn-ghost h-native-memory-refresh" onClick={() => void refresh()} disabled={loading} aria-label="刷新记忆" title="刷新"><RefreshCw aria-hidden="true" /></button>
    </div>
    {error && <p role="alert" className="h-native-memory-error">{error}</p>}
    {loading ? <div className="h37-group h-native-memory-document"><p role="status" className="h-native-memory-empty">正在读取记忆…</p></div> : snapshot && <>
      {files.length > 1 && <label className="h-native-memory-picker">选择文件<select className="h37-select" value={path} onChange={event => setSelected(event.target.value)}>{files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>}
      <div className="h37-group h-native-memory-document" data-empty={!path || text === ''}>
        {path ? <>
          <div className="h-native-memory-file-header"><code>{path}</code><button type="button" className="h37-btn h37-btn-ghost" disabled={text === null} onClick={() => void copy(text ?? '')} aria-label="复制原文"><Copy aria-hidden="true" />复制</button></div>
          {text === null ? <p role="status" className="h-native-memory-empty">正在读取文件…</p> : !text.trim() ? <p className="h-native-memory-empty">这个文件还是空的。</p> : category === 'recovery' ? <pre>{text}</pre> : <Markdown text={text} wrapTables />}
        </> : <div className="h-native-memory-empty"><p>暂无{group.label}</p>{category === 'long' && <span>在对话中说「记住……」即可添加。</span>}</div>}
      </div>
      {category === 'recovery' && files.length > 0 && <p className="h-native-memory-help">在对话中提供记录 ID 即可恢复。</p>}
      <div className="h-native-memory-summary">
        <span>自动整理到每日日志</span>
        <InfoPopover open={summaryInfoOpen} onOpenChange={setSummaryInfoOpen} title="自动整理" side="top"
          trigger={<button type="button" className="h37-btn h37-btn-ghost h-native-memory-info" aria-label="自动整理说明"><Info aria-hidden="true" /></button>}>
          <p>结束会话或退出应用时，按需整理重要信息。摘要使用当前模型，用量暂未计入对话统计。</p>
        </InfoPopover>
      </div>
    </>}
    {toastNode}
  </section>;
}
