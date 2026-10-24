import type {ReactNode} from 'react';
import {ErrorBoundary, ErrorState} from '@hemi/ui';
import {useFlow} from '../host/context.js';

export function TranscriptBoundary({children}: {children: ReactNode}) {
  const {runtime} = useFlow();
  return <ErrorBoundary resetKey={runtime} onError={() => runtime.diagnostic('render-failed', '对话列表显示失败')} fallback={(_error, reset) => <ErrorState description="对话列表显示失败，请重新打开。" actions={[{label:'重新打开',className:'h24-edit-cancel',onAction:reset}]}/>}>{children}</ErrorBoundary>;
}
