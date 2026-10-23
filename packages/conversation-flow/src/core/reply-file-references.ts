import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Nodes } from 'mdast';
import { decodeFileHref, inlineFilePath } from '../shared/local-file-link.js';

const parser = unified().use(remarkParse);
export type ReplyFileReference = { path: string; name: string; description?: string };

/** Explicit Markdown links/images and complete code paths only; never scan prose or code blocks. */
export function replyFileReferences(text: string): { files: ReplyFileReference[]; directories: string[] } {
  const tree = parser.parse(text);
  const files = new Map<string, ReplyFileReference>();
  const directories = new Set<string>();
  const definitions = new Map<string, string>();
  const walk = (node: Nodes, visit: (node: Nodes, inLink: boolean) => void, inLink = false) => {
    visit(node, inLink);
    if ('children' in node) for (const child of node.children) walk(child, visit, inLink || node.type === 'link' || node.type === 'linkReference');
  };
  walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url); });
  const add = (url: string, description?: string, explicit = false) => {
    const path = /^file:\/\//i.test(url) ? url : decodeFileHref(url);
    if (/^(?:#|[a-z][a-z\d+.-]*:)/i.test(path) && !/^file:\/\//i.test(path) && !/^[a-z]:[/\\]/i.test(path)) return;
    if (!inlineFilePath(path) && !(explicit && /^[\p{L}\p{N}_. ()@%-]+\.[a-z\d]{1,12}$/iu.test(path))) return;
    const name = path.split(/[/\\]/).pop() || path;
    files.set(path, { path, name, ...(description && description !== name ? { description } : {}) });
  };
  walk(tree, (node, inLink) => {
    if (node.type === 'link' || node.type === 'image') add(node.url, node.type === 'image' ? node.alt ?? undefined : undefined, true);
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = definitions.get(node.identifier.toLowerCase());
      if (url) add(url, node.type === 'imageReference' ? node.alt ?? undefined : undefined, true);
    }
    if (node.type === 'inlineCode' && !inLink) {
      add(node.value);
      if (/[/\\]$/.test(node.value) && !/[\r\n<>|`;$]/.test(node.value)) directories.add(node.value.replace(/^\.\//, ''));
    }
  });
  return { files: [...files.values()], directories: [...directories] };
}
