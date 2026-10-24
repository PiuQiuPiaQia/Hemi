import type {ReactNode} from 'react';
import {ErrorBoundary, ErrorState} from '@hemi/ui';

export function AppBoundary({children, onReturn}: {children: ReactNode; onReturn(): void}) {
  return <ErrorBoundary fallback={(_error, reset) => <ErrorState as="section" className="connect-scroll" title="暂时无法打开对话" titleAs="h1" description="请返回连接页后重试。" descriptionClassName="body-copy" actions={[{label:'返回连接页',className:'primary-button',onAction:()=>{reset();onReturn();}}]}/>}>{children}</ErrorBoundary>;
}
