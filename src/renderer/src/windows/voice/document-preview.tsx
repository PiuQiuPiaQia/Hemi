import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { unzipSync } from 'fflate';
import type { ArtifactPreviewResult, AttachmentDocumentPreview } from '@shared/protocol';
import cmapArchiveUrl from '../../../../../third-party/pdfjs/cmaps.zip?url';

// ZCode's preview is the interaction reference: read-only sheets, fitted white
// pages, page controls, lazy format renderers and stale-render guards. This is a
// separate implementation using Hemi's controlled attachment identities.
const FRAME_HTML = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:;"><style>html,body{margin:0;padding:0;background:white;color:#202020}body{overflow:hidden}*{box-sizing:border-box}</style></head><body></body></html>`;

async function createDocumentFrame(host: HTMLElement, name: string) {
  const frame = document.createElement('iframe');
  frame.title = `${name} 原文预览`;
  frame.className = 'h-doc-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.srcdoc = FRAME_HTML;
  host.replaceChildren(frame);
  await ready;
  const doc = frame.contentDocument;
  if (!doc) throw new Error('文档预览未能打开');
  doc.addEventListener('click', (event) => {
    if ((event.target as Element)?.closest?.('a')) event.preventDefault();
  });
  return { frame, doc };
}

type PdfPage = { getViewport: (options: { scale: number }) => { width: number; height: number }; render: (options: object) => { promise: Promise<void>; cancel: () => void } };
type PdfDocument = { numPages: number; getPage: (page: number) => Promise<PdfPage>; loadingTask: { destroy: () => Promise<void> } };
let cmapPromise: Promise<Record<string, Uint8Array>> | undefined;
async function pdfCmaps() {
  cmapPromise ??= fetch(cmapArchiveUrl).then(async (response) => {
    if (!response.ok) throw new Error('PDF 字符映射读取失败');
    return unzipSync(new Uint8Array(await response.arrayBuffer()));
  }).catch((error) => { cmapPromise = undefined; throw error; });
  return cmapPromise;
}

function Spreadsheet({ sheets }: { sheets: NonNullable<AttachmentDocumentPreview['sheets']> }) {
  const [selected, setSelected] = useState(0);
  const sheet = sheets[selected];
  let columns = [...new Set(sheet?.rows.flatMap((row) => row.map((cell) => cell.address.replace(/\d+/g, ''))) ?? [])]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const lastColumn = columns.at(-1) ?? '';
  const count = [...lastColumn].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
  if (count > 0 && count <= 64) columns = Array.from({ length: count }, (_, index) => {
    let value = index + 1, name = '';
    while (value > 0) { value -= 1; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
    return name;
  });
  return <div className="h-doc-spreadsheet">
    <div className="h-doc-sheet-tabs" role="tablist" aria-label="工作表">
      {sheets.map((item, index) => <button key={index} type="button" role="tab" aria-selected={index === selected} aria-controls="h-doc-sheet-panel" tabIndex={index === selected ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (selected + 1) % sheets.length : event.key === 'ArrowLeft' ? (selected + sheets.length - 1) % sheets.length : event.key === 'Home' ? 0 : event.key === 'End' ? sheets.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); setSelected(next);
        event.currentTarget.parentElement?.querySelectorAll('button').item(next)?.focus();
      }}>{item.name || `工作表 ${index + 1}`}</button>)}
    </div>
    <div className="h-doc-sheet-scroll" role="tabpanel" id="h-doc-sheet-panel" aria-label={sheet?.name} tabIndex={0}>
      <table className="h-doc-sheet"><thead><tr><th aria-label="行号" />{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{sheet?.rows.map((row, index) => <tr key={index}><th scope="row">{row[0]?.address.match(/\d+/)?.[0] ?? index + 1}</th>{columns.map((column) => {
          const cell = row.find((item) => item.address.replace(/\d+/g, '') === column);
          return <td key={column} title={cell?.formula ? `公式：=${cell.formula}（显示已保存的计算值）` : undefined}>{cell?.value ?? ''}</td>;
        })}</tr>)}</tbody>
      </table>
      {!sheet?.rows.length ? <p className="h24-preview-status">工作表没有可显示的单元格</p> : null}
    </div>
    {sheet?.truncated ? <p className="h-doc-note">内容过长，预览已截断（最多 500 行、每行 64 个非空单元格）。</p> : null}
  </div>;
}

export default function DocumentPreview({ source, name, readText }: { source: AttachmentDocumentPreview; name: string; readText: () => Promise<ArtifactPreviewResult> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState<ArtifactPreviewResult | null>(null);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(1, Math.floor(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !width || textMode || source.format === 'xlsx' || !source.bytes) return;
    let active = true;
    let dispose: (() => void) | undefined;
    setStatus('loading'); setError(''); host.replaceChildren();
    const surfaceStyle = getComputedStyle(host);
    const available = Math.max(1, width - parseFloat(surfaceStyle.paddingLeft) - parseFloat(surfaceStyle.paddingRight));
    void (async () => {
      if (source.format === 'pdf') {
        const pdfjs = await import('unpdf/pdfjs') as unknown as { getDocument: (options: object) => { promise: Promise<PdfDocument>; destroy: () => Promise<void> } };
        if (!active) return;
        class LocalDataReader { async fetch({ kind, filename }: { kind: string; filename: string }) {
          if (kind !== 'cMapUrl') throw new Error('PDF 字体资源不可用');
          const bytes = (await pdfCmaps())[filename];
          if (!bytes) throw new Error('PDF 字符映射不可用');
          return bytes;
        } }
        const task = pdfjs.getDocument({ data: source.bytes!.slice(), isEvalSupported: false, useSystemFonts: true, useWasm: false, useWorkerFetch: false, BinaryDataFactory: LocalDataReader });
        dispose = () => { void task.destroy(); };
        const pdf = await task.promise;
        if (!active) return;
        setPages(pdf.numPages);
        const current = await pdf.getPage(Math.min(page, pdf.numPages));
        if (!active) return;
        const natural = current.getViewport({ scale: 1 });
        const scale = Math.min(1, available / natural.width) * zoom;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const viewport = current.getViewport({ scale: scale * ratio });
        if (viewport.width * viewport.height > 16_000_000 || viewport.width > 32767 || viewport.height > 32767) throw new Error('页面过大，请缩小文档或查看提取文字');
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-label', `${name} 第 ${page} 页`);
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width / ratio}px`; canvas.style.height = `${viewport.height / ratio}px`;
        host.replaceChildren(canvas);
        const render = current.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
        dispose = () => { render.cancel(); void task.destroy(); };
        await render.promise;
      } else if (source.format === 'docx') {
        const { renderAsync } = await import('docx-preview');
        if (!active) return;
        const { frame, doc } = await createDocumentFrame(host, name);
        if (!active) { frame.remove(); return; }
        const root = doc.createElement('div');
        await renderAsync(source.bytes!.slice(), root, root, { className: 'hemi-docx', useBase64URL: true, breakPages: true, ignoreLastRenderedPageBreak: true, renderAltChunks: false, renderChanges: false });
        if (!active) { frame.remove(); return; }
        root.querySelectorAll('a').forEach((anchor) => anchor.removeAttribute('href'));
        doc.body.append(root);
        await doc.fonts.ready;
        if (!active) { frame.remove(); return; }
        const wrapper = root.querySelector<HTMLElement>('.hemi-docx-wrapper');
        if (wrapper) { wrapper.style.padding = '0'; wrapper.style.background = 'transparent'; wrapper.style.width = 'max-content'; }
        root.querySelectorAll<HTMLElement>('section.hemi-docx').forEach((section) => { section.style.boxShadow = 'none'; });
        const naturalWidth = root.querySelector<HTMLElement>('section.hemi-docx')?.offsetWidth || 794;
        const scale = Math.min(1, available / naturalWidth) * zoom;
        const naturalHeight = Math.max(root.scrollHeight, doc.body.scrollHeight);
        root.style.zoom = String(scale);
        frame.style.width = `${naturalWidth * scale}px`; frame.style.height = `${naturalHeight * scale}px`;
      } else if (source.format === 'pptx') {
        const { parseZipLazyMedia, buildPresentation, renderSlide, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer/browser');
        const files = await parseZipLazyMedia(source.bytes!.slice().buffer, RECOMMENDED_ZIP_LIMITS);
        if (!active) return;
        const presentation = buildPresentation(files, { lazySlides: true });
        if (!presentation.slides.length) throw new Error('演示文稿没有幻灯片');
        setPages(presentation.slides.length);
        const handle = renderSlide(presentation, presentation.slides[Math.min(page - 1, presentation.slides.length - 1)]!, { onNavigate: () => undefined });
        dispose = () => handle.dispose();
        const { frame, doc } = await createDocumentFrame(host, name);
        if (!active) { frame.remove(); handle.dispose(); return; }
        doc.body.append(handle.element);
        await handle.ready;
        if (!active) return;
        handle.element.querySelectorAll('a').forEach((anchor) => anchor.removeAttribute('href'));
        const scale = Math.min(1, available / presentation.width) * zoom;
        handle.element.style.transformOrigin = 'top left'; handle.element.style.transform = `scale(${scale})`;
        frame.style.width = `${presentation.width * scale}px`; frame.style.height = `${presentation.height * scale}px`;
      }
      if (active) setStatus('ready');
    })().catch((failure: unknown) => {
      if (!active) return;
      setStatus('error'); setError(failure instanceof Error ? failure.message : '原文预览失败');
      host.replaceChildren();
    });
    return () => { active = false; dispose?.(); host.replaceChildren(); };
  }, [source, width, page, zoom, textMode, name]);

  const showText = async () => {
    setTextMode(true); setText(null);
    try { setText(await readText()); } catch { setText({ ok: false, message: '文字读取失败，请重试' }); }
  };
  const paged = source.format === 'pdf' || source.format === 'pptx';
  return <section className="h-doc-viewer" aria-label={`${name} 文档预览`}>
    <div className="h-doc-controls">
      <div className="h-doc-view-switch" aria-label="预览方式">
        <button type="button" aria-pressed={!textMode} onClick={() => setTextMode(false)}>原文预览</button>
        <button type="button" aria-pressed={textMode} onClick={() => void showText()}>提取文字</button>
      </div>
      {!textMode && paged ? <div className="h-doc-pages">
        <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="size-3.5" /></button>
        <span aria-live="polite">{page} / {pages}</span>
        <button type="button" aria-label="下一页" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="size-3.5" /></button>
      </div> : null}
      {!textMode && source.format !== 'xlsx' ? <div className="h-doc-zoom">
        <button type="button" aria-label="缩小文档" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}><Minus className="size-3.5" /></button>
        <button type="button" title="适应宽度" onClick={() => setZoom(1)}>{zoom === 1 ? '适应' : `${Math.round(zoom * 100)}%`}</button>
        <button type="button" aria-label="放大文档" disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom + 0.25))}><Plus className="size-3.5" /></button>
      </div> : null}
    </div>
    <div className="h-doc-viewport" ref={viewportRef}>
      {textMode ? text ? <pre className="h24-preview-plain">{text.ok ? text.text : text.message}</pre> : <p className="h24-preview-status">正在提取文字…</p>
        : source.format === 'xlsx' ? <Spreadsheet sheets={source.sheets ?? []} />
          : <><div className="h-doc-surface" ref={hostRef} aria-busy={status === 'loading'} data-ready={status === 'ready'} />
            {status === 'error' ? <div className="h24-preview-error" role="alert"><p>原文预览失败：{error}</p><button type="button" className="h37-btn h37-btn-secondary" onClick={() => void showText()}>查看提取文字</button></div> : null}</>}
    </div>
  </section>;
}
