import {useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode} from 'react';
import {X} from 'lucide-react';

export function IconButton({label, children, className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {label: string; children: ReactNode}) {
  return <button type="button" className={`icon-control ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function useDialogFocus(onClose: () => void, returnFocus?: HTMLElement | null) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    ref.current?.focus({preventScroll:true});
    return () => { requestAnimationFrame(() => { if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected && !previous.closest('[inert]')) previous.focus({preventScroll:true}); }); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const targets = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(node => node.getClientRects().length > 0);
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus({preventScroll:true}); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus({preventScroll:true}); }
  };
  return {ref, onKeyDown};
}

export function Sheet({title, onClose, footer, children, returnFocus}: {title: string; onClose(): void; footer?: ReactNode; children: ReactNode; returnFocus?: HTMLElement | null}) {
  const dialog = useDialogFocus(onClose, returnFocus);
  return <div className="modal-layer">
    <button type="button" className="sheet-backdrop" aria-label="关闭面板" tabIndex={-1} onClick={onClose}/>
    <section {...dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="bottom-sheet">
      <div className="sheet-grabber" aria-hidden="true"/><header className="sheet-heading"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18}/></IconButton></header>
      <div className="sheet-content">{children}</div>{footer ? <footer className="sheet-footer">{footer}</footer> : null}
    </section>
  </div>;
}
