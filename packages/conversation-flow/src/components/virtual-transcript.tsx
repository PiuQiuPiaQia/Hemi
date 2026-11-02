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
  readHistory: () => void;
  scrollToBottom: (options?: { behavior?: "instant" | "smooth" }) => void;
  scrollToMessage: (
    id: string,
    options?: { align?: "start" | "center" | "end" },
  ) => Promise<void>;
};

/** One scroll owner. The key on this component scopes all measurements/UI state to a generation. */
export function VirtualTranscript({
  rowIds,
  questionIds,
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
  questionIds: string[];
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
  const endIntent = useRef(false);
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
  useEffect(() => {
    history?.follow?.(following && !editingId && retained.length === 0);
  }, [history?.follow, following, editingId, retained.length]);
  const intent = useTranscriptViewport(viewport, {
    history,
    nearStart: () => {
      const first = virtualizer.getVirtualItemForOffset(viewport?.scrollTop ?? 0);
      // All rows belonging to the first three QAs prefetch the previous ten.
      const fourth = questionIds[3] ? rowIds.indexOf(questionIds[3]) : rowIds.length;
      return first !== undefined && first.index < fourth;
    },
    read: () => {endIntent.current = false; virtualizer.cancelScroll(); setPinned(false);},
    towardEnd: () => {endIntent.current = true;},
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
    useAnimationFrameWithResizeObserver: true,
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
      // Prepend anchoring also scrolls forward. Only an actual downward input
      // may resume following after the user has started reading history.
      if (instance.isAtEnd(1) && (pinned.current || endIntent.current)) setPinned(true);
      else if (
        !pinned.current &&
        endIntent.current &&
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
      // Set the ref synchronously before a button starts its request: fast IPC
      // can finish before React ever renders the intermediate loading state.
      readHistory: () => {intent.current(); endIntent.current = false; interactionVersion.current++; virtualizer.cancelScroll(); setPinned(false);},
      scrollToBottom: jump,
      scrollToMessage: async (id, options) => {
        const index = rowIds.indexOf(id);
        if (index >= 0) {
          intent.current();
          endIntent.current = false;
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
  const previousTotal = useRef(history?.total);
  useLayoutEffect(() => {
    if (!viewport || loading) return;
    // Initial open and own sends position directly; asynchronous measurements keep the end anchored.
    // A local echo moving into the Host queue exposes an older last user; it is not another send.
    const previousTail = previousKeys.current.at(-1);
    const tailIndex = previousTail ? rowIds.indexOf(previousTail) : -1;
    // The Host can create an assistant placeholder before delivering its user.
    // That user is inserted before the old tail, but advances the canonical total.
    const liveAppend = history?.total !== undefined && previousTotal.current !== undefined && history.total > previousTotal.current;
    const userAdded = previousUser.current !== lastUserId && lastUserId !== null && !previousKeys.current.includes(lastUserId)
      && (liveAppend || (tailIndex >= 0 && rowIds.indexOf(lastUserId) > tailIndex));
    if ((userAdded && !history?.gap) || pinned.current) jump();
    previousUser.current = lastUserId;
    previousTotal.current = history?.total;
  }, [viewport, loading, lastUserId, jump, Boolean(history?.gap), history?.total]);
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
