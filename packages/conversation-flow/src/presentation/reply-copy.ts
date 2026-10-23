import type { TranscriptItem } from "../types/presentation.js";

/** 一轮回答只在收口后的末尾提供复制；正文分段不改变运行归属。 */
export function replyCopyTargets(items: TranscriptItem[]): Map<string, string> {
  const groups = new Map<
    string,
    { lastId: string; live: boolean; texts: string[] }
  >();
  let legacyReply = 0;
  for (const item of items) {
    if (item.withdrawn) continue;
    if (item.author === "user") {
      legacyReply += 1;
      continue;
    }
    const key = item.flow?.runId
      ? `run:${item.flow.runId}`
      : `legacy:${legacyReply}`;
    let group = groups.get(key);
    if (!group) {
      group = { lastId: item.id, live: false, texts: [] };
      groups.set(key, group);
    }
    group.lastId = item.id;
    group.live ||= Boolean(item.live);
    if (item.kind) continue;
    const text = item.parts?.length
      ? item.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : item.text;
    if (text.trim()) group.texts.push(text);
  }
  const targets = new Map<string, string>();
  for (const group of groups.values()) {
    if (!group.live && group.texts.length)
      targets.set(group.lastId, group.texts.join("\n\n"));
  }
  return targets;
}
