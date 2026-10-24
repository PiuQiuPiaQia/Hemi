import {useState, type ComponentProps, type RefObject} from 'react';
import {Menu} from './menu.js';
import {Sheet} from './sheet.js';

export type ControlDisclosureProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
};
/** A host may coordinate several surfaces; standalone controls own the same disclosure state. */
export function useControlDisclosure({open, defaultOpen = false, onOpenChange}: ControlDisclosureProps = {}) {
  const [local, setLocal] = useState(defaultOpen);
  const visible = open ?? local;
  const setOpen = (next: boolean) => {if (open === undefined) setLocal(next); onOpenChange?.(next);};
  return {open: visible, setOpen, close: () => setOpen(false), toggle: () => setOpen(!visible)};
}

export function SelectionSurface({presentation = 'menu', title, anchorRef, returnFocus, children, menuProps, ...props}: {
  presentation?: 'menu' | 'sheet';
  title: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  returnFocus?: HTMLElement | null;
  menuProps?: Omit<ComponentProps<typeof Menu>, 'open' | 'onClose' | 'anchorRef' | 'children'>;
} & Pick<ComponentProps<typeof Menu>, 'open' | 'onClose' | 'children'>) {
  if (!props.open) return null;
  return presentation === 'sheet'
    ? <Sheet title={title} onClose={props.onClose} returnFocus={returnFocus ?? anchorRef.current}>{children}</Sheet>
    : <Menu {...props} {...menuProps} anchorRef={anchorRef} placement={menuProps?.placement ?? 'anchor-up'}>{children}</Menu>;
}
