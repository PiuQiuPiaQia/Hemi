import type {ReactNode} from 'react';
import { Markdown } from '../shared/markdown.js';
export type PreviewContent = {
    kind: 'image';
    url: string;
} | {
    kind: 'video';
    url: string;
} | {
    kind: 'markdown' | 'text';
    text: string;
};
/** Resource bytes and system operations belong to the host; content is shared. */
export function ResourceContent({ content, name, presentation = 'sheet', onImageError, renderMarkdown }: {
    content: PreviewContent;
    name: string;
    presentation?: 'sheet' | 'panel';
    onImageError?(): void;
    renderMarkdown?(text:string):ReactNode;
}) {
    if (content.kind === 'image')
        return <img className={presentation === 'sheet' ? 'resource-preview-image' : 'h24-preview-image'} src={content.url} alt={name} onError={onImageError}/>;
    if (content.kind === 'video')
        return <video className="resource-preview-image" controls playsInline preload="metadata" src={content.url} aria-label={name} onError={onImageError}/>;
    if (content.kind === 'markdown')
        return <article className={presentation === 'sheet' ? 'resource-preview-markdown' : 'h24-preview-doc'}>{renderMarkdown ? renderMarkdown(content.text) : <Markdown text={content.text}/>}</article>;
    return <pre className={presentation === 'sheet' ? 'resource-preview-text' : 'h24-preview-plain'}>{content.text || (presentation === 'sheet' ? '（空文件）' : '')}</pre>;
}
