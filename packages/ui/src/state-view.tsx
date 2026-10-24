import type {HTMLAttributes, ReactNode} from 'react';

export interface StateAction {
  label: ReactNode;
  onAction(): void;
  disabled?: boolean;
  className?: string;
}

export interface StateViewProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'div' | 'section';
  kind?: 'empty' | 'loading' | 'error';
  illustration?: ReactNode;
  title?: ReactNode;
  titleAs?: 'h1' | 'h2' | 'h3' | 'p';
  titleClassName?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  actions?: readonly StateAction[];
}

/** Presentation only: the host decides whether data is loading, empty, cached or failed. */
export function StateView({as: Root = 'div', kind = 'empty', illustration, title, titleAs: Heading = 'h2', titleClassName, description, descriptionClassName, actions = [], children, role, ...props}: StateViewProps) {
  return <Root {...props} data-state-view={kind} role={role ?? (kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined)}>
    {illustration}
    {title ? <Heading className={titleClassName}>{title}</Heading> : null}
    {description ? <p className={descriptionClassName}>{description}</p> : null}
    {children}
    {actions.map((action, index) => <button key={index} type="button" className={action.className} disabled={action.disabled} onClick={action.onAction}>{action.label}</button>)}
  </Root>;
}

export function EmptyState(props: Omit<StateViewProps, 'kind'>) {return <StateView {...props} kind="empty"/>;}
export function LoadingState(props: Omit<StateViewProps, 'kind'>) {return <StateView {...props} kind="loading"/>;}
export function ErrorState(props: Omit<StateViewProps, 'kind'>) {return <StateView {...props} kind="error"/>;}
