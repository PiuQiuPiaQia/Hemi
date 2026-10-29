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

import {useTranscriptViewport} from './use-transcript-viewport.js';
import type {FlowSurfaceState} from '../types/api.js';

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
  history,
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
  history?: FlowSurfaceState['history'];
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
  const [following, setFollowing] = useState(true);
  const interactionVersion = useRef(0);
  const store = useMemo<TranscriptRowStates>(() => new Map(), []);
  const setPinned = useCallback(
    (value: boolean) => {
      if (pinned.current === value) return;
      pinned.current = value;
      setFollowing(value);
      onPinnedChange(value);
    },
    [onPinnedChange],
  );
  const intent = useTranscriptViewport(viewport, {
    history,
    historyHeight: () => body.current?.parentElement?.querySelector('.h24-history-load')?.clientHeight ?? 0,
    read: () => {virtualizer.cancelScroll(); setPinned(false);},
    interact: () => {interactionVersion.current++;},
  });
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
    useFlushSync: true,
    useAnimationFrameWithResizeObserver: false,
    getScrollElement: () => viewport,
    getItemKey: getKey,
    estimateSize: () => 220,
    // A remounted/backfilled row may have different content than its cached size.
    // Measure the mounted DOM before positioning its neighbours, including on iOS.
    measureElement: (element, entry) =>
      entry?.borderBoxSize?.[0]?.blockSize ??
      element.getBoundingClientRect().height,
    overscan: 4,
    rangeExtractor: extract,
    scrollMargin: margin,
    // End anchoring also preserves the visible row when history is prepended.
    // Following new output is controlled separately by the reader's intent.
    anchorTo: "end",
    followOnAppend: following ? "auto" : false,
    scrollEndThreshold: following ? 1 : 0,
    onChange: (instance) => {
      if (instance.isAtEnd(1)) setPinned(true);
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
      intent.current();
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
          intent.current();
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
    const readMargin = () => body.current!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    let contentMargin = readMargin();
    const measureMargin = () => {contentMargin = readMargin(); setMargin(contentMargin);};
    measureMargin();
    let height = el.clientHeight;
    let contentHeight = body.current.offsetHeight;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const nextContentHeight = body.current!.offsetHeight;
      if (height === el.clientHeight && contentHeight === nextContentHeight && Math.abs(contentMargin - readMargin()) < 0.5) return;
      const follow = pinned.current;
      height = el.clientHeight;
      contentHeight = nextContentHeight;
      const version = interactionVersion.current;
      cancelAnimationFrame(frame);
      // Both keyboard/composer resizing and asynchronous row measurements move the end.
      // Let the virtualizer consume those measurements before restoring the user's end intent.
      frame = requestAnimationFrame(() => {
        measureMargin();
        if (follow && pinned.current && interactionVersion.current === version) jump();
      });
    });
    observer.observe(el);
    observer.observe(body.current);
    if (body.current.parentElement) observer.observe(body.current.parentElement);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [jump]);
  const previousUser = useRef(lastUserId);
  const previousKeys = useRef(rowIds);
  useLayoutEffect(() => {
    if (!viewport || loading) return;
    // Initial open and own sends position directly; asynchronous measurements keep the end anchored.
    // A local echo moving into the Host queue exposes an older last user; it is not another send.
    const userAdded = previousUser.current !== lastUserId && lastUserId !== null && !previousKeys.current.includes(lastUserId);
    if ((userAdded && !history?.gap) || pinned.current) jump();
    previousUser.current = lastUserId;
  }, [viewport, loading, lastUserId, jump, Boolean(history?.gap)]);
  useEffect(() => {
    const valid = new Set(rowIds);
    for (const id of store.keys()) if (!valid.has(id)) store.delete(id);
    previousKeys.current = rowIds;
  }, [rowIds, store]);
  useEffect(() => {
    if (!viewport) return;
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
    viewport.addEventListener("focusin", retain);
    viewport.addEventListener("focusout", retain);
    document.addEventListener("selectionchange", retain);
    return () => {
      viewport.removeEventListener("focusin", retain);
      viewport.removeEventListener("focusout", retain);
      document.removeEventListener("selectionchange", retain);
    };
  }, [viewport]);
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
