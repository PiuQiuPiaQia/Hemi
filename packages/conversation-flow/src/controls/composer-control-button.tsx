import type {ComponentProps, ReactNode} from 'react';
import {Brain, ChevronDown, Cpu, Folder} from 'lucide-react';
export type ComposerControlLayout = 'desktop' | 'touch';
export type ComposerControlButtonProps = ComponentProps<'button'> & {
  kind: 'model' | 'thinking' | 'directory';
  layout?: ComposerControlLayout;
  label?: string;
  text?: string;
  icon?: ReactNode;
  chevron?: boolean;
  indicator?: ReactNode;
};
/** Shared trigger markup; applications choose content and platform actions. */
export function ComposerControlButton({kind, layout = 'desktop', label, text, icon, chevron = kind !== 'directory' || layout === 'desktop', indicator, className, ...props}: ComposerControlButtonProps) {
  const touch = layout === 'touch';
  const classes = touch ? kind === 'directory' ? 'icon-control' : `composer-option composer-${kind}` : kind === 'model' ? 'h24-model-chip h37-tool' : kind === 'directory' ? 'h33-workspace-chip h37-tool' : 'h37-tool';
  const textClass = touch ? undefined : kind === 'model' ? 'h24-model-chip-label h37-tool-label' : kind === 'directory' ? 'h33-workspace-chip-label h37-tool-label' : 'h37-tool-label';
  const glyph = icon !== undefined ? icon : kind === 'model' ? touch ? null : <Cpu aria-hidden="true"/> : kind === 'thinking' ? <Brain size={touch ? 16 : undefined} aria-hidden="true"/> : <Folder size={touch ? 16 : undefined} aria-hidden="true"/>;
  return <button type="button" {...props} aria-label={label} className={className ?? classes}>
    {glyph}{text ? <span className={textClass}>{text}</span> : null}{indicator}
    {chevron ? <ChevronDown size={touch ? 12 : undefined} className={touch ? undefined : 'h37-tool-chev'} aria-hidden="true"/> : null}
  </button>;
}
export function DirectoryControlButton(props: Omit<ComposerControlButtonProps, 'kind'>) {return <ComposerControlButton {...props} kind="directory"/>;}
