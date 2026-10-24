import {useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode} from 'react';

export interface StatusNoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  layout?: 'desktop' | 'touch';
  variant?: 'banner' | 'inline' | 'note';
  title?: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

/** Hosts supply wording and actions; the shared view owns live-region semantics and layout. */
export function StatusNotice({layout = 'desktop', variant = 'banner', title, detail, icon, actions, children, className = '', role = 'status', ...props}: StatusNoticeProps) {
  return <div {...props} role={role} className={`h-status-notice ${className}`} data-layout={layout} data-variant={variant}>
    {icon}
    {title || detail ? <div className="h-status-content">{title ? <strong>{title}</strong> : null}{detail ? <p>{detail}</p> : null}{children}</div> : typeof children === 'string' || typeof children === 'number' ? <span className="h-status-content">{children}</span> : children}
    {actions}
  </div>;
}

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  layout?: 'desktop' | 'touch';
  tone?: 'error';
  icon?: ReactNode;
}

export function Toast({layout = 'desktop', tone, icon, children, className = '', ...props}: ToastProps) {
  return <div {...props} className={`${layout === 'desktop' ? 'h37-toast h37-toast-card' : 'h-touch-toast'} ${className}`} role="status" data-tone={tone === 'error' ? 'err' : undefined}>
    {icon}<span>{children}</span>
  </div>;
}

/** A replacement, even with the same message, gets its own full display interval. */
export function useTransientMessage<T>(duration = 2600): [T | null, (value: T | null) => void] {
  const [entry, setEntry] = useState<{value: T} | null>(null);
  const show = useCallback((value: T | null) => setEntry(value === null ? null : {value}), []);
  useEffect(() => {
    if (!entry) return;
    const timer = setTimeout(() => setEntry(current => current === entry ? null : current), duration);
    return () => clearTimeout(timer);
  }, [entry, duration]);
  return [entry?.value ?? null, show];
}

/** The caller keys this component by receipt identity; unmount cancels the old acknowledgement. */
export function TimedToast({duration = 2600, onExpire, ...props}: ToastProps & {duration?: number; onExpire?(): void}) {
  const [visible, setVisible] = useState(true);
  const expire = useRef(onExpire);
  useEffect(() => {expire.current = onExpire;}, [onExpire]);
  useEffect(() => {
    const timer = setTimeout(() => {setVisible(false); expire.current?.();}, duration);
    return () => clearTimeout(timer);
  }, [duration]);
  return visible ? <Toast {...props}/> : null;
}
