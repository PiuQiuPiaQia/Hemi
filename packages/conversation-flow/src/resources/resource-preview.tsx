import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppWindow, Download, FileText, Share2 } from 'lucide-react';
import { ResourceContent } from './resource-content.js';
import { Markdown } from '../shared/markdown.js';
import type { ConversationFlowHost, FlowScope, HostContext, ResourceActionView, ResourceLease, ResourceRef, ResourceDocument } from '../types/api.js';
import { ResourceProgressView } from './resource-progress.js';
import { IDLE_PROGRESS } from './progress.js';
import type { ResourceTransfers } from './progress.js';
import {ErrorState, Sheet} from '@hemi/ui';
const emptySubscribe = () => () => { };
export type ResourcePreviewRequest = {
    ref?: ResourceRef;
    href?: string;
    name?: string;
};
export function ResourcePreview({ host, scope, request, onClose, returnFocus, transfers, renderDocument, onLocalLink }: {
    onLocalLink?(href: string): void;
    renderDocument?(source: ResourceDocument, name: string): ReactNode;
    transfers?: ResourceTransfers;
    host: ConversationFlowHost;
    scope: FlowScope;
    request: ResourcePreviewRequest;
    onClose(): void;
    returnFocus: HTMLElement | null;
}) {
    const [attempt, setAttempt] = useState(0), [lease, setLease] = useState<ResourceLease | null>(null), [ref, setRef] = useState<ResourceRef | null>(null);
    const [actions, setActions] = useState<readonly ResourceActionView[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
    const progress = useSyncExternalStore(transfers?.subscribe ?? emptySubscribe, () => transfers?.getProgress(scope, ref) ?? IDLE_PROGRESS);
    const refresh = () => { if (ref)
        transfers?.invalidate(scope, ref); setAttempt(value => value + 1); };
    const actionController = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController(), context: HostContext = { scope, signal: controller.signal, requestId: crypto.randomUUID() };
        let acquired: ResourceLease | null = null;
        setLoading(true);
        setError('');
        setLease(null);
        setActions([]);
        setRef(null);
        void (async () => {
            try {
                const resource = host.resources;
                if (!resource?.read)
                    throw new Error('此环境未提供文件预览');
                let target = request.ref;
                if (!target && request.href && resource.resolve) {
                    const result = await resource.resolve({ href: request.href }, context);
                    if (!result.ok)
                        throw new Error(result.error.message);
                    target = result.value;
                }
                if (!target)
                    throw new Error('文件身份无效');
                if (controller.signal.aborted)
                    return;
                setRef(target);
                const [content, options] = await Promise.all([resource.read({ ref: target, purpose: 'preview' }, context), resource.listActions?.({ ref: target }, context)]);
                if (content.ok)
                    acquired = content.value;
                if (controller.signal.aborted) {
                    acquired?.release();
                    acquired = null;
                    return;
                }
                if (options?.ok)
                    setActions(options.value);
                if (!content.ok)
                    throw new Error(content.error.message);
                setLease(content.value);
            }
            catch (error) {
                if (!controller.signal.aborted)
                    setError(error instanceof Error ? error.message : '文件读取失败');
            }
            finally {
                if (!controller.signal.aborted)
                    setLoading(false);
            }
        })();
        return () => { controller.abort(); actionController.current?.abort(); acquired?.release(); };
    }, [host, scope, request, attempt]);
    const perform = async (actionId: string) => {
        if (!ref || busy || !host.resources?.perform)
            return;
        const controller = new AbortController();
        actionController.current = controller;
        setBusy(true);
        setActionError('');
        try {
            const result = await host.resources.perform({ ref, actionId }, { scope, signal: controller.signal, requestId: crypto.randomUUID() });
            if (!controller.signal.aborted && !result.ok && result.error.code !== 'cancelled')
                setActionError(result.error.message);
        }
        catch (error) {
            if (!controller.signal.aborted)
                setActionError(error instanceof Error ? error.message : '文件操作失败');
        }
        finally {
            if (!controller.signal.aborted)
                setBusy(false);
        }
    };
    const name = lease?.metadata?.name ?? request.name ?? '文件预览', content = lease?.content;
    return <Sheet returnFocus={returnFocus} title={name} onClose={onClose} footer={actions.length ? <div className="resource-actions" aria-busy={busy}>{actions.map(action => <button type="button" className="secondary-button" key={action.id} disabled={busy || !!action.disabledReason} title={action.disabledReason} onClick={() => void perform(action.id)}>{action.kind === 'save' ? <Download size={17}/> : action.kind === 'share' ? <Share2 size={17}/> : <AppWindow size={17}/>}<span>{action.label}</span></button>)}{busy ? <ResourceProgressView progress={progress}/> : null}{actionError ? <p role="alert">{actionError}</p> : null}</div> : undefined}>
    <div className="resource-preview-content">
      {loading ? <ResourceProgressView progress={progress}/> : error ? <ErrorState className="resource-preview-error" illustration={<FileText size={28} aria-hidden="true"/>} description={error} actions={[{label:'重试',className:'text-button',onAction:refresh}]}/> : content?.kind === 'document' ? renderDocument?.(content.source, name) ?? <ResourceContent content={{kind:'text',text:content.source.text??'请使用系统预览查看这份文档。'}} name={name}/> : content ? <ResourceContent content={content.kind === 'url' ? { kind: content.mimeType.startsWith('video/') ? 'video' : 'image', url: content.url } : { kind: content.mimeType === 'text/markdown' ? 'markdown' : 'text', text: content.text }} name={name} renderMarkdown={text => <Markdown text={text} onLocalLink={onLocalLink}/>} onImageError={() => setError('媒体加载失败，可尝试系统预览')}/> : null}
    </div>
    {!loading && !error && transfers ? <div className="resource-preview-tools"><button type="button" className="text-button" disabled={busy} onClick={refresh}>刷新</button></div> : null}
  </Sheet>;
}
