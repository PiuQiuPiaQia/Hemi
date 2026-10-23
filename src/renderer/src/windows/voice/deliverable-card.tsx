import {useConversationBridge,useConversationEnvironment,useConversationOnline} from './lib/conversation-bridge';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AppWindow, FileArchive, FileCode2, FileSpreadsheet, FileText, Download, FolderOpen, ImageIcon, Presentation, RotateCcw, Video } from 'lucide-react';
import type { ConversationDeliverableReadResult, FileOpenApplicationsResult, TurnPart } from '@shared/protocol';
import { Menu, MenuGroup, MenuSeparator } from '@/components/menu';

export const DeliverableContext = createContext<{
  conversationId: string | null;
  onOpen: (artifactId: string) => void;
  onOpenLink: (path: string) => void;
} | null>(null);

type FilePart = Extract<TurnPart, { type: 'file-delivery' }>;
type Preview = { key: string; result: ConversationDeliverableReadResult };
const imageExtension = /\.(png|jpe?g|gif|webp|svg)$/i;

function filePresentation(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (imageExtension.test(name)) return { Icon: ImageIcon, label: '图片' };
  if (/^(xlsx?|csv|tsv|ods)$/.test(extension)) return { Icon: FileSpreadsheet, label: '表格' };
  if (/^(pptx?|odp)$/.test(extension)) return { Icon: Presentation, label: '演示文稿' };
  if (/^(zip|gz|tar|7z|rar)$/.test(extension)) return { Icon: FileArchive, label: '压缩文件' };
  if (/^(mp4|mov|webm|m4v)$/.test(extension)) return { Icon: Video, label: '视频' };
  if (/^(html?|json|xml|js|ts|py|css)$/.test(extension)) return { Icon: FileCode2, label: extension.toUpperCase() };
  return { Icon: FileText, label: extension === 'pdf' ? 'PDF 文档' : '文档' };
}

function fileSize(size?: number | null) {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Bounded to mounted, visible cards. Identity guards prevent old reads flashing after navigation/update. */
export function DeliverableCards({ files, onOpen }: { files: FilePart[]; onOpen?: (artifactId: string, name: string) => void }) {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const onResolved = useCallback((key: string, identity: string) => {
    setResolved(previous => previous[key] === identity ? previous : { ...previous, [key]: identity });
  }, []);
  const seen = new Set<string>();
  const visibleFiles = files.filter(file => {
    const key = JSON.stringify([file.conversationId, file.artifactId || file.linkPath]);
    const identity = resolved[key] ?? (file.artifactId ? `${file.conversationId}:${file.artifactId}` : key);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return <div className="h62-deliverables" aria-label="交付文件">
    {visibleFiles.map(file => <DeliverableCard key={file.artifactId || file.linkPath} file={file} onOpen={onOpen} onResolved={onResolved} />)}
  </div>;
}

function DeliverableCard({ file, onOpen, onResolved }: { file: FilePart; onOpen?: (artifactId: string, name: string) => void;
  onResolved: (key: string, identity: string) => void }) {
  const bridge = useConversationBridge();
  const bot = useConversationEnvironment() === 'bot';
  const runtimeOnline = useConversationOnline();
  const context = useContext(DeliverableContext);
  const conversationId = file.conversationId ?? context?.conversationId;
  const key = JSON.stringify([conversationId, file.artifactId, file.linkPath, file.contentVersion]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dimensions, setDimensions] = useState<{ key: string; ratio: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [applications, setApplications] = useState<{ key: string; result: FileOpenApplicationsResult } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const isImage = imageExtension.test(file.name);
  const { Icon, label } = filePresentation(file.name);
  const result = preview?.key === key ? preview.result : null;
  const error = result && !result.ok ? result.message || '文件读取失败' : null;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !conversationId) return;
    if (bot && !runtimeOnline) return;
    let disposed = false;
    setPreview(null);
    const load = async () => {
      // Resolve all link forms once at the host (including file URLs and relative paths).
      const target = file.linkPath ? await bridge.resolveConversationLink(conversationId, file.linkPath) : null;
      if (disposed) return null;
      if (target && !target.ok) return target;
      const id = target?.artifactId ?? file.artifactId;
      onResolved(JSON.stringify([file.conversationId, file.artifactId || file.linkPath]), `${file.conversationId}:${id}`);
      if (!isImage) return target ?? { ok: true };
      return bridge.readConversationDeliverable(conversationId, id, target?.path ?? null);
    };
    void load().then(value => {
      if (!disposed && value) setPreview({ key, result: value });
    }).catch(() => {
      if (!disposed) setPreview({ key, result: { ok: false, message: '文件读取失败，可重试' } });
    });
    return () => { disposed = true; };
  }, [visible, conversationId, key, file.conversationId, file.artifactId, file.linkPath, isImage, attempt, onResolved, bridge, bot, runtimeOnline]);

  const menuOpen = menuPoint !== null;
  useEffect(() => {
    if (!menuOpen || !conversationId) return;
    let disposed = false;
    const load = async (): Promise<FileOpenApplicationsResult> => {
      const target = file.linkPath ? await bridge.resolveConversationLink(conversationId, file.linkPath) : null;
      if (target && !target.ok) return { ok: false, applications: [], message: target.message };
      if (disposed) return { ok: false, applications: [] };
      return bridge.listConversationDeliverableApplications(conversationId, target?.artifactId ?? file.artifactId, target?.path ?? null);
    };
    void load().then(result => {
      if (!disposed) setApplications({ key, result });
    }).catch(() => {
      if (!disposed) setApplications({ key, result: { ok: false, applications: [], message: '暂时无法读取可用程序' } });
    });
    return () => { disposed = true; };
  }, [menuOpen, conversationId, key, file.artifactId, file.linkPath]);

  const name = result?.name || file.name;
  const details = [name, file.description, [label, fileSize(result?.size ?? file.size)].filter(Boolean).join(' · '), file.host ? `远端 · ${file.host}` : null].filter(Boolean).join('\n');
  const open = () => {
    if (file.linkPath) context?.onOpenLink(file.linkPath);
    else if (onOpen) onOpen(file.artifactId, file.name);
    else context?.onOpen(file.artifactId);
  };
  const openMenu = (point: { x: number; y: number }) => { setApplications(null); setMenuPoint(point); };
  const appResult = applications?.key === key ? applications.result : null;
  const act = async (intent: 'reveal' | 'application' | 'download', applicationId: string | null = null) => {
    setMenuPoint(null); setActionError(null);
    if (!conversationId) return;
    try {
      const target = file.linkPath ? await bridge.resolveConversationLink(conversationId, file.linkPath) : null;
      if (target && !target.ok) { setActionError(target.message || '文件不可用'); return; }
      const outcome: {ok:boolean;message?:string} = intent === 'download'
        ? await bridge.bot.download(conversationId,target?.artifactId ?? file.artifactId)
        : await bridge.openConversationDeliverable(conversationId, target?.artifactId ?? file.artifactId, target?.path ?? null, intent, applicationId);
      if (!outcome.ok) setActionError(outcome.message || '文件操作失败');
    } catch { setActionError('文件操作失败，可稍后重试'); }
  };
  return <div ref={root} className="h62-deliverable-card" data-kind={isImage ? 'image' : 'file'} data-state={error ? 'error' : isImage && !result?.dataUrl ? 'loading' : 'ready'}
    style={isImage ? { '--h62-image-ratio': dimensions?.key === key ? dimensions.ratio : 1.5 } as CSSProperties : undefined}
    onContextMenu={event => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }); }}>
    <button type="button" className="h62-deliverable-open" onClick={open} disabled={!context && !onOpen}
      aria-label={`预览 ${name}`} title={details}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); openMenu({ x: bounds.left, y: bounds.bottom });
        }
      }}>
      {isImage ? <span className="h62-deliverable-thumbnail" aria-busy={!result}>
        {result?.ok && result.dataUrl ? <img src={result.dataUrl} alt={file.description || file.name}
          onLoad={event => setDimensions({ key, ratio: event.currentTarget.naturalWidth / event.currentTarget.naturalHeight })}
          onError={() => setPreview({ key, result: { ok: false, message: '图片无法解码，可重新读取' } })} />
          : <><ImageIcon aria-hidden="true" /><span>{error ? '图片暂时无法显示' : '图片加载中'}</span></>}
      </span> : <span className="h62-deliverable-icon"><Icon aria-hidden="true" /></span>}
      <span className="h62-deliverable-info">
        <span className="h62-deliverable-name">{name}</span>
      </span>
    </button>
    {error ? <div className="h62-deliverable-error" role="status"><span>{error}</span>
      <button type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw aria-hidden="true" />重试</button>
    </div> : null}
    {actionError ? <div className="h62-deliverable-error" role="status">{actionError}</div> : null}
    <Menu open={menuOpen} onClose={() => setMenuPoint(null)} placement="fixed" position={menuPoint ? { ...menuPoint } : undefined}>
      {bot ? <button type="button" role="menuitem" className="h37-menu-item" disabled={!runtimeOnline} onClick={() => void act('download')}><Download aria-hidden="true" /><span>下载云端文件</span></button> : <>
      <MenuGroup label="打开方式" />
      <div className="h62-file-applications" aria-busy={!appResult}>
        {appResult?.applications.map(application => <button key={application.id} type="button" role="menuitem" className="h37-menu-item" tabIndex={-1}
          onClick={() => void act('application', application.id)}>
          {application.icon ? <img className="h62-application-icon" src={application.icon} alt="" /> : <AppWindow aria-hidden="true" />}
          <span className="h62-application-name">{application.name}</span>
          {application.isDefault ? <small className="h62-application-default">默认</small> : null}
        </button>)}
        {!appResult || !appResult.applications.length ? <div className="h62-application-note" role="status">
          {!appResult ? '正在查找可用程序…' : appResult.message || '没有找到可用程序'}
        </div> : null}
      </div>
      <MenuSeparator />
      <button type="button" role="menuitem" className="h37-menu-item" tabIndex={-1} disabled={Boolean(file.host)} onClick={() => void act('reveal')}><FolderOpen aria-hidden="true" /><span>打开所在目录</span></button>
      </>}
    </Menu>
  </div>;
}
