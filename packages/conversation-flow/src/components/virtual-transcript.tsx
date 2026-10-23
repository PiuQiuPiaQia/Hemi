import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import {
  TranscriptRowState,
  type TranscriptRowStates,
} from "./transcript-row-state.js";
import { MarkdownParseCache } from "../shared/markdown-parse-cache.js";
import { MarkdownCacheContext } from "../shared/markdown-cache-context.js";

export type VirtualTranscriptHandle = {
  scrollToBottom: (options?: { behavior?: "instant" | "smooth" }) => void;
  scrollToMessage: (
    id: string,
    options?: { align?: "start" | "center" | "end" },
  ) => Promise<void>;
};

/** One scroll owner. The key on this component scopes all measurements/UI state to a generation. */
export function VirtualTranscript({
  rowIds,
  editingId,
  renderRow,
  getRowText,
  onPinnedChange,
  lastUserId,
  loading,
  ref,
}: {
  rowIds: string[];
  editingId: string | null;
  renderRow: (index: number) => ReactNode;
  getRowText: (
    index: number,
    state: Map<string, unknown> | undefined,
  ) => string;
  onPinnedChange: (pinned: boolean) => void;
  lastUserId: string | null;
  loading: boolean;
  ref?: Ref<VirtualTranscriptHandle>;
}) {
  const body = useRef<HTMLDivElement>(null);
  const parseCache = useMemo(
    () =>
      new MarkdownParseCache(() => {
        if (body.current) {
          body.current.dataset.markdownParses = String(parseCache.parses);
          body.current.dataset.markdownCacheEntries = String(parseCache.size);
          body.current.dataset.markdownCacheBytes = String(parseCache.bytes);
        }
      }),
    [],
  );
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [retained, setRetained] = useState<string[]>([]);
  const pinned = useRef(true);
  const store = useMemo<TranscriptRowStates>(() => new Map(), []);
  const setPinned = useCallback(
    (value: boolean) => {
      if (pinned.current === value) return;
      pinned.current = value;
      onPinnedChange(value);
    },
    [onPinnedChange],
  );
  const getKey = useCallback((index: number) => rowIds[index], [rowIds]);
  const retainedIndexes = useMemo(() => {
    const ids = new Set(
      [...retained, editingId].filter((id): id is string => !!id),
    );
    return [...ids]
      .slice(0, 2)
      .map((id) => rowIds.indexOf(id))
      .filter((i) => i >= 0);
  }, [editingId, retained, rowIds]);
  const extract = useCallback(
    (range: Range) =>
      [...new Set([...defaultRangeExtractor(range), ...retainedIndexes])].sort(
        (a, b) => a - b,
      ),
    [retainedIndexes],
  );
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rowIds.length,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    useFlushSync: false,
    getScrollElement: () => viewport,
    getItemKey: getKey,
    estimateSize: () => 220,
    measureElement: (element, entry, instance) =>
      entry?.borderBoxSize?.[0]?.blockSize ??
      instance.itemSizeCache.get(
        instance.options.getItemKey(instance.indexFromElement(element)),
      ) ??
      element.getBoundingClientRect().height,
    overscan: 4,
    rangeExtractor: extract,
    scrollMargin: margin,
    anchorTo: pinned.current ? "end" : "start",
    followOnAppend: pinned.current ? "auto" : false,
    scrollEndThreshold: pinned.current ? 1 : 0,
    onChange: (instance) => {
      if (
        instance.isScrolling &&
        instance.scrollDirection === "backward" &&
        !instance.isAtEnd(0)
      ) {
        instance.cancelScroll();
        setPinned(false);
      } else if (instance.isAtEnd(1)) setPinned(true);
      else if (
        !pinned.current &&
        instance.isScrolling &&
        instance.scrollDirection === "forward" &&
        instance.isAtEnd(36)
      ) {
        setPinned(true);
        instance.scrollToEnd();
      }
    },
  });
  const jump = useCallback(
    (options?: { behavior?: "instant" | "smooth" }) => {
      setPinned(true);
      virtualizer.scrollToEnd({
        behavior:
          options?.behavior === "smooth" &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "smooth"
            : "auto",
      });
    },
    [virtualizer, setPinned],
  );
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: jump,
      scrollToMessage: async (id, options) => {
        const index = rowIds.indexOf(id);
        if (index >= 0) {
          setPinned(false);
          virtualizer.scrollToIndex(index, {
            align: options?.align ?? "start",
          });
        }
      },
    }),
    [jump, rowIds, virtualizer, setPinned],
  );
  useLayoutEffect(() => onPinnedChange(true), [onPinnedChange]);
  useLayoutEffect(() => {
    const el =
      body.current?.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null;
    setViewport(el);
    if (!el || !body.current) return;
    const measureMargin = () =>
      setMargin(
        body.current!.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop,
      );
    measureMargin();
    const observer = new ResizeObserver(measureMargin);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const previousUser = useRef(lastUserId);
  const previousKeys = useRef(rowIds);
  useLayoutEffect(() => {
    if (!viewport || loading) return;
    // Initial open and own sends position directly; asynchronous measurements keep the end anchored.
    if (previousUser.current !== lastUserId || pinned.current) jump();
    previousUser.current = lastUserId;
  }, [viewport, loading, lastUserId, jump]);
  useEffect(() => {
    const valid = new Set(rowIds);
    for (const id of store.keys()) if (!valid.has(id)) store.delete(id);
    for (const key of virtualizer.itemSizeCache.keys())
      if (!valid.has(String(key))) virtualizer.itemSizeCache.delete(key);
    if (previousKeys.current.some((id) => !valid.has(id))) parseCache.clear();
    previousKeys.current = rowIds;
  }, [rowIds, store, virtualizer, parseCache]);
  useEffect(() => {
    if (!viewport) return;
    const unpin = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        virtualizer.cancelScroll();
        setPinned(false);
      }
    };
    const retain = () => {
      const selection = window.getSelection();
      const rowOf = (node: Node | null) => {
        const element = (
          node instanceof Element ? node : node?.parentElement
        )?.closest<HTMLElement>("[data-virtual-row]");
        return element && body.current?.contains(element)
          ? element.dataset.virtualRow
          : undefined;
      };
      const ids =
        selection && !selection.isCollapsed
          ? [rowOf(selection.anchorNode), rowOf(selection.focusNode)]
          : [rowOf(document.activeElement)];
      const next = [...new Set(ids.filter((id): id is string => !!id))].slice(
        0,
        2,
      );
      setRetained((prev) =>
        prev.join("\0") === next.join("\0") ? prev : next,
      );
    };
    viewport.addEventListener("wheel", unpin, { passive: true });
    viewport.addEventListener("focusin", retain);
    viewport.addEventListener("focusout", retain);
    document.addEventListener("selectionchange", retain);
    return () => {
      viewport.removeEventListener("wheel", unpin);
      viewport.removeEventListener("focusin", retain);
      viewport.removeEventListener("focusout", retain);
      document.removeEventListener("selectionchange", retain);
    };
  }, [viewport, setPinned, virtualizer]);
  const bindBody = useCallback(
    (node: HTMLDivElement | null) => {
      body.current = node;
      virtualizer.containerRef(node);
    },
    [virtualizer],
  );
  return (
    <MarkdownCacheContext.Provider value={parseCache}>
      <div
        ref={bindBody}
        className="h67-virtual-transcript"
        data-virtual-total={rowIds.length}
        onCopy={(event) => {
          if (
            event.target instanceof HTMLTextAreaElement ||
            event.target instanceof HTMLInputElement
          )
            return;
          const selection = window.getSelection();
          if (!selection?.rangeCount || selection.isCollapsed) return;
          const range = selection.getRangeAt(0);
          const rowOf = (node: Node) =>
            (node instanceof Element
              ? node
              : node.parentElement
            )?.closest<HTMLElement>("[data-virtual-row]");
          const start = rowOf(range.startContainer),
            end = rowOf(range.endContainer);
          if (!start || !end || start === end) return;
          const from = rowIds.indexOf(start.dataset.virtualRow!),
            to = rowIds.indexOf(end.dataset.virtualRow!);
          if (from < 0 || to <= from) return;
          const head = range.cloneRange();
          head.selectNodeContents(start);
          head.setStart(range.startContainer, range.startOffset);
          const tail = range.cloneRange();
          tail.selectNodeContents(end);
          tail.setEnd(range.endContainer, range.endOffset);
          const texts = [head.toString()];
          for (let i = from + 1; i < to; i++)
            texts.push(getRowText(i, store.get(rowIds[i])));
          texts.push(tail.toString());
          event.preventDefault();
          event.clipboardData.setData("text/plain", texts.join("\n\n"));
        }}
      >
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            data-virtual-row={rowIds[row.index]}
            className="h67-virtual-row"
          >
            <TranscriptRowState store={store} rowId={rowIds[row.index]}>
              {renderRow(row.index)}
            </TranscriptRowState>
          </div>
        ))}
      </div>
    </MarkdownCacheContext.Provider>
  );
}
