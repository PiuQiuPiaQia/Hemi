import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";

export type TranscriptRowStates = Map<string, Map<string, unknown>>;
type Scope = { values: Map<string, unknown>; prefix: string };
const RowState = createContext<Scope | null>(null);

/** UI-only state, owned by the current conversation's virtual list, never by DOM nodes. */
export function TranscriptRowState({
  store,
  rowId,
  children,
}: {
  store: TranscriptRowStates;
  rowId: string;
  children: ReactNode;
}) {
  const scope = useMemo(() => {
    let values = store.get(rowId);
    if (!values) {
      values = new Map();
      store.set(rowId, values);
    }
    return { values, prefix: "" };
  }, [store, rowId]);
  return <RowState.Provider value={scope}>{children}</RowState.Provider>;
}

export function TranscriptPartState({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const parent = useContext(RowState);
  const scope = useMemo(
    () =>
      parent
        ? { values: parent.values, prefix: `${parent.prefix}${id}/` }
        : null,
    [parent, id],
  );
  return <RowState.Provider value={scope}>{children}</RowState.Provider>;
}

export function useTranscriptRowState<T>(
  key: string,
  initial: T,
): [T, (next: SetStateAction<T>) => void] {
  const scope = useContext(RowState);
  const fullKey = `${scope?.prefix ?? ""}${key}`;
  const [value, setValue] = useState<T>(() =>
    scope?.values.has(fullKey) ? (scope.values.get(fullKey) as T) : initial,
  );
  const current = useRef(value);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = useCallback(
    (next: SetStateAction<T>) => {
      const result =
        typeof next === "function"
          ? (next as (previous: T) => T)(current.current)
          : next;
      current.current = result;
      scope?.values.set(fullKey, result);
      if (mounted.current) setValue(result);
    },
    [scope, fullKey],
  );
  return [value, update];
}
