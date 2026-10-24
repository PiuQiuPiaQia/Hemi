import type { FlowSnapshotView, ConversationDeliverableView } from './protocol.js';
import { retainedDeliverables } from './retained-deliverables.js';
import { replyFileReferences } from './reply-file-references.js';

type FlowPart = { partId: string; kind: string } & Record<string, unknown>;
const referencesByItem = new WeakMap<object, ReturnType<typeof replyFileReferences>>();
const cardsByArtifact = new WeakMap<object, Map<string, FlowPart>>();

/** Recover presentation from explicit evidence without mutating the archive or registering guessed files. */
export function flowDeliverableParts(snapshot: FlowSnapshotView): Map<string, FlowPart[]> {
  const artifacts = retainedDeliverables(snapshot);
  const byId = new Map(artifacts.map(a => [a.artifactId, a]));
  const byPath = new Map(artifacts.map(a => [a.path, a]));
  const byRun = new Map<string, ConversationDeliverableView[]>();
  for (const artifact of artifacts) for (const runId of new Set([artifact.producerRunId, ...(artifact.producers ?? []).map(p => p.runId)])) {
    if (!runId) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId)!.push(artifact);
  }
  const result = new Map<string, FlowPart[]>();
  const tails = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  const keys = (runId: string) => {
    if (!seen.has(runId)) seen.set(runId, new Set());
    return seen.get(runId)!;
  };
  const delivery = (artifact: ConversationDeliverableView, partId: string): FlowPart => {
    let cards = cardsByArtifact.get(artifact);
    if (!cards) { cards = new Map(); cardsByArtifact.set(artifact, cards); }
    const key = `${snapshot.conversationId}:${partId}`;
    if (!cards.has(key)) cards.set(key, { ...artifact, partId, kind: 'deliverable', conversationId: snapshot.conversationId });
    return cards.get(key)!;
  };
  for (const item of snapshot.timeline) {
    if (item.kind !== 'assistant') continue;
    // Old registrations used a root-only row instead of the producing input's row.
    const target = item.afterInputId == null && item.parts.length > 0 && item.parts.every(p => p.kind === 'deliverable')
      ? tails.get(item.runId) ?? item.itemId : item.itemId;
    const parts = result.get(target) ?? [];
    result.set(target, parts);
    let references = referencesByItem.get(item);
    if (!references) {
      references = replyFileReferences(item.parts.filter(p => p.kind === 'text').map(p => String(p.content ?? '')).join('\n\n'));
      referencesByItem.set(item, references);
    }
    for (const part of item.parts) {
      if (part.kind !== 'deliverable') { parts.push(part); continue; }
      const id = String(part.artifactId ?? '');
      const artifact = byId.get(id);
      if (!artifact) continue;
      if (keys(item.runId).has(id)) continue;
      keys(item.runId).add(id);
      parts.push(delivery(artifact, part.partId));
    }
    // A read is evidence only when its image is already a registered deliverable AND
    // the assistant explicitly handed over its directory. Reference images stay tool activity.
    for (const part of item.parts) {
      if (part.kind !== 'tool' || part.tool !== 'read' || part.status !== 'done') continue;
      const path = (part.args as { path?: string } | undefined)?.path;
      const artifact = path ? byPath.get(path) : undefined;
      if (!artifact || artifact.previewKind !== 'image' || keys(item.runId).has(artifact.artifactId)) continue;
      if (!references.directories.some(dir => artifact.path.startsWith(dir) || artifact.path.includes(`/${dir}`))) continue;
      keys(item.runId).add(artifact.artifactId);
      parts.push(delivery(artifact, `recovered:${part.partId}`));
    }
    for (const reference of references.files) {
      // Relative links belong to their producing run's directory, even after
      // the conversation selects another directory with the same filenames.
      const relative = !/^(?:[/\\]|[a-z]:[/\\]|file:)/i.test(reference.path);
      const suffix = reference.path.replaceAll('\\', '/').replace(/^\.\//, '');
      const produced = (byRun.get(item.runId) ?? []).filter(a =>
        (a.path === reference.path || relative && a.path.replaceAll('\\', '/').endsWith('/' + suffix)));
      const artifact = produced.at(-1) ?? byPath.get(reference.path);
      // 正文路径只提供点击入口；没有登记事实就不能冒充交付卡片。
      if (!artifact) continue;
      const key = artifact.artifactId;
      if (keys(item.runId).has(key)) continue;
      keys(item.runId).add(key);
      parts.push(delivery(artifact, `file:${item.itemId}:${key}`));
    }
    tails.set(item.runId, target);
  }
  // Recover an existing registry entry whose timeline part never arrived.
  for (const artifact of artifacts) {
    const producers = artifact.producers?.length ? artifact.producers : [{ runId: artifact.producerRunId }];
    for (const producer of producers) {
      const runId = producer.runId;
      const target = runId ? tails.get(runId) : undefined;
      if (!runId || !target || keys(runId).has(artifact.artifactId)) continue;
      keys(runId).add(artifact.artifactId);
      result.get(target)!.push(delivery(artifact, `registry:${runId}:${artifact.artifactId}`));
    }
  }
  return result;
}
