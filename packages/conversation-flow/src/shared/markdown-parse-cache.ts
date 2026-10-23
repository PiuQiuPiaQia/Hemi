import type { Root } from "mdast";
import type { Processor } from "unified";

/** Bounded syntax trees only. No React elements, callbacks, DOM, decoded images or old sessions. */
export class MarkdownParseCache {
  private entries = new Map<string, { tree: Root; bytes: number }>();
  bytes = 0;
  parses = 0;
  hits = 0;
  private changed: () => void;
  constructor(changed: () => void = () => {}) {
    this.changed = changed;
  }
  parse(text: string, parse: () => Root): Root {
    const cached = this.entries.get(text);
    if (cached) {
      this.entries.delete(text);
      this.entries.set(text, cached);
      this.hits++;
      this.changed();
      return structuredClone(cached.tree); // remark transformers must never mutate the reusable source.
    }
    const tree = parse();
    this.parses++;
    const bytes = new TextEncoder().encode(
      text + JSON.stringify(tree),
    ).byteLength;
    if (bytes <= 4 * 1024 * 1024) {
      while (this.entries.size >= 128 || this.bytes + bytes > 4 * 1024 * 1024) {
        const key = this.entries.keys().next().value;
        if (key == null) break;
        this.bytes -= this.entries.get(key)!.bytes;
        this.entries.delete(key);
      }
      this.entries.set(text, { tree: structuredClone(tree), bytes });
      this.bytes += bytes;
    }
    this.changed();
    return tree;
  }
  get size() {
    return this.entries.size;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.changed();
  }
}

/** Per-processor wrapper preserves react-markdown's sanitizing/link/image/rendering pipeline. */
export function remarkCachedParser(
  this: Processor,
  cache: MarkdownParseCache | null,
) {
  const original = this.parser;
  if (!cache || !original) return;
  this.parser = (text, file) =>
    cache.parse(text, () => original(text, file) as Root);
}
