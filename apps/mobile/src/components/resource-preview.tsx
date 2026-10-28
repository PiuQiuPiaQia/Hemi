import {lazy, memo, Suspense, useMemo, type ComponentProps} from 'react';
import {LoadingState} from '@hemi/ui';
import type {ResourceDocument} from '@hemi/conversation-flow';
import {ResourcePreview as SharedResourcePreview} from '@hemi/conversation-flow/resources';
export type {ResourcePreviewRequest as MobilePreview} from '@hemi/conversation-flow/resources';
const DocumentPreview = lazy(() => import('../../../../src/shared/components/document-preview'));
const Document = memo(function Document({source, name}: {source: ResourceDocument; name: string}) {
  const document = useMemo(() => ({ok: true, ...source}), [source]);
  return <Suspense fallback={<LoadingState description="正在加载文档预览…"/>}><DocumentPreview source={document} name={name} readText={async () => (source.textError ? {ok: false, message: source.textError} : {ok: true, kind: 'text', text: source.text ?? '这份文档没有可提取的文字，请使用原文或系统预览。'})}/></Suspense>;
});
const renderDocument = (source: ResourceDocument, name: string) => <Document source={source} name={name}/>;

/** The same document renderer serves PC panels and the wise drawer. */
export function ResourcePreview(props: ComponentProps<typeof SharedResourcePreview>) {
  return <SharedResourcePreview {...props} renderDocument={renderDocument}/>;
}
