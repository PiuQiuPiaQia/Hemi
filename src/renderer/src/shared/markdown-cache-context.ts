import { createContext } from 'react';
import type { MarkdownParseCache } from './markdown-parse-cache';
export const MarkdownCacheContext = createContext<MarkdownParseCache | null>(null);
