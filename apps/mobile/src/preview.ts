import type {FlowActionRequest, ResourceRef} from '@hemi/conversation-flow';
import type {MobilePreview} from './components/resource-preview';

/** One selection owns the drawer. Replacing it never creates a tab or a stack. */
export type MobilePreviewTarget =
  | {kind: 'resource'; request: MobilePreview}
  | {kind: 'task'; taskId: string; confirmStop: boolean}
  | {kind: 'report'; taskId: string}
  | {kind: 'workflow'; invocationId: string};

export function previewTarget(action: FlowActionRequest): MobilePreviewTarget | null {
  if (action.type === 'task.stop') return {kind: 'task', taskId: action.targetId, confirmStop: true};
  if (action.type !== 'preview.open') return null;
  if (action.target === 'task') return {kind: 'task', taskId: action.taskId ?? action.targetId, confirmStop: false};
  if (action.target === 'workflow') return {kind: 'workflow', invocationId: action.invocationId ?? action.targetId};
  if (action.resource?.id.startsWith('task-body:')) return {kind: 'report', taskId: action.resource.id.slice(10)};
  return {kind: 'resource', request: {ref: action.resource, href: action.href, name: action.name}};
}

export function taskArtifactReference(ref: ResourceRef | undefined): {taskId: string; artifactId: string} | null {
  if (!ref?.id.startsWith('task-artifact:')) return null;
  const split = ref.id.indexOf(':', 14);
  return split < 0 ? null : {taskId: ref.id.slice(14, split), artifactId: ref.id.slice(split + 1)};
}
