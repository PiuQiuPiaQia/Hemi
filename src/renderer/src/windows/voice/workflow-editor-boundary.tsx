import type {ReactNode} from 'react';
import {ErrorBoundary, ErrorState} from '@hemi/ui';
import {createLogger} from '@/shared/log';

const log = createLogger('workflow-canvas');

/** A canvas/library failure must leave navigation and the saved definition usable. */
export function WorkflowEditorBoundary({children, onBack}: {children: ReactNode; onBack?: () => void}) {
  return <ErrorBoundary onError={error => log.error(error.stack ?? error.message)} fallback={(error, reset) => <ErrorState className="h59-canvas-error" title="流程画布未能打开" description="已保存的工作流仍然保留。可以重试，或返回列表。" actions={[{label:'重试',onAction:reset},...(onBack ? [{label:'返回工作流',onAction:onBack}] : [])]}><p className="h59-hint">{error.message}</p></ErrorState>}>{children}</ErrorBoundary>;
}
