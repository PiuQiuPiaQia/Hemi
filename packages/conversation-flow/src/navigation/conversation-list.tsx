import {Fragment, type ReactNode} from 'react';

export interface ConversationGroup<T> {
  key: string;
  label: string;
  items: readonly T[];
}

export interface ConversationListProps<T extends {id: string}> {
  items?: readonly T[];
  groups?: readonly ConversationGroup<T>[];
  as?: 'div' | 'nav';
  className?: string;
  label?: string;
  groupClassName?: string;
  empty?: ReactNode;
  renderItem(item: T, index: number): ReactNode;
  renderHeading?(group: ConversationGroup<T>, index: number): ReactNode;
  /** Desktop adapters may wrap a group's rows in their existing drag-and-drop provider. */
  wrapGroupItems?(group: ConversationGroup<T>, rows: ReactNode): ReactNode;
}

/** Data subscriptions, grouping policy, selection and mutations remain controlled by the host. */
export function ConversationList<T extends {id: string}>({items = [], groups, as: Root = 'div', className, label, groupClassName, empty, renderItem, renderHeading, wrapGroupItems}: ConversationListProps<T>) {
  const rows = (values: readonly T[]) => values.map((item, index) => <Fragment key={item.id}>{renderItem(item, index)}</Fragment>);
  const visibleGroups = groups?.filter(group => group.items.length);
  return <Root className={className} aria-label={label}>
    {visibleGroups ? visibleGroups.length ? visibleGroups.map((group, index) => {
      const content = rows(group.items);
      return <section key={group.key} className={groupClassName} aria-label={group.label}>
        {renderHeading ? renderHeading(group, index) : <h2>{group.label}</h2>}
        {wrapGroupItems ? wrapGroupItems(group, content) : content}
      </section>;
    }) : empty : items.length ? rows(items) : empty}
  </Root>;
}
