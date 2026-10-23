import { createContext } from "react";
import type { MarkdownParseCache } from "./markdown-parse-cache.js";
export const MarkdownCacheContext = createContext<MarkdownParseCache | null>(
  null,
);
