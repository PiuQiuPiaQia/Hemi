/**
 * 059 人工输入节点 executor（HI 通用节点）：到达即准备挂起——把冻结文档里的
 * content／fields／actions 解析成一次可渲染的 interaction（上游变量已代入、动态
 * 选项已冻结、预填已解析、上游文件产物已核验留 manifest），抛 code='human-input'
 * 交 runner 持久挂起。本 executor 不做任何等待、不轮询模型——挂起期间零 SDK／
 * 工具／桌面资源（HI-R02）。
 *
 * 输入命名约定（toRuntimeSchema 与此处同一套确定性命名）：
 * - 内容变量按解析顺序 `__hi_c<i>`；
 * - 单选动态选项 `__hi_opts_<fieldId>`、多行预填 `__hi_pre_<fieldId>`。
 */
import crypto from "node:crypto";
import { parseHumanInputContentVars } from "../../shared/workflow.mjs";
import { workflowError } from "./invocation-store.mjs";

export const HUMAN_INPUT_ERROR = "human-input";

export const contentVarInputName = (index) => `__hi_c${index}`;
export const optionsInputName = (field) => `__hi_opts_${field.fieldId ?? field.key}`;
export const prefillInputName = (field) => `__hi_pre_${field.fieldId ?? field.key}`;

const display = (value) => {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join("、");
  return String(value);
};

/**
 * 冻结一次人工输入请求（纯函数，runner 在同进程内调用）。
 * @param {object} params
 * @param {object} params.nodeData 冻结文档的节点 data（content/fields/actions/wait）
 * @param {object} params.inputs 运行时已解析输入（__hi_c*／__hi_opts_*／__hi_pre_*）
 * @param {object} params.document 冻结文档（判断变量上游类型）
 * @param {Function} [params.verifyFile] (path) => Promise<{ok, reason?, manifests?}>
 */
export async function buildInteraction({ nodeData, inputs, document, verifyFile = null, invocationId = null, workflowRunId = null, nodeId = null, nodeAttemptId = null }) {
  const contentVars = parseHumanInputContentVars(nodeData.content);
  const contentIssues = [];
  let content = String(nodeData.content ?? "");
  const upstreamFiles = {};
  const upstreamFileManifests = {};
  for (const [i, ref] of contentVars.entries()) {
    const name = contentVarInputName(i);
    const raw = inputs?.[name];
    const shown = display(raw);
    if (shown == null) {
      contentIssues.push(`变量 {{${ref.nodeId}.${ref.key}}} 没有取到值`);
      content = content.split(`{{${ref.nodeId}.${ref.key}}}`).join("【未取到】");
      continue;
    }
    content = content.split(`{{${ref.nodeId}.${ref.key}}}`).join(shown);
    const upstreamType = upstreamTypeOf(document, ref.nodeId, ref.key);
    if (["file", "files"].includes(upstreamType) && typeof raw === "string" && verifyFile) {
      upstreamFiles[`${ref.nodeId}.${ref.key}`] = raw;
      const verdict = await verifyFile(raw);
      if (verdict?.ok) upstreamFileManifests[`${ref.nodeId}.${ref.key}`] = verdict.manifests ?? null;
    }
  }

  const fields = [];
  for (const field of nodeData.fields ?? []) {
    const config = field.config ?? {};
    const frozen = {
      fieldId: field.fieldId ?? field.key,
      key: field.key,
      label: field.label || field.key,
      type: field.type,
      required: Boolean(field.required),
    };
    if (field.type === "choice") {
      if (config.optionsBinding) {
        const rawOptions = inputs?.[optionsInputName(field)];
        if (!Array.isArray(rawOptions) || rawOptions.some((o) => typeof o !== "string")) {
          frozen.options = [];
          frozen.optionsError = `选项来源没有提供字符串列表（来自 ${config.optionsBinding.nodeId ?? config.optionsBinding.key}）`;
        } else {
          frozen.options = [...rawOptions];
        }
      } else {
        frozen.options = [...(config.options ?? [])];
      }
    }
    if (field.type === "text") {
      if (config.prefillBinding) frozen.prefill = display(inputs?.[prefillInputName(field)]) ?? "";
      else frozen.prefill = config.prefillText ?? "";
    }
    fields.push(frozen);
  }

  const wait = nodeData.wait ?? { mode: "forever" };
  return {
    interactionId: `hi-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    nodeId,
    nodeAttemptId,
    workflowRunId,
    invocationId,
    title: nodeData.title || "人工输入",
    content,
    contentIssues,
    fields,
    actions: (nodeData.actions ?? []).map((a) => ({
      actionId: a.actionId,
      label: a.label,
      primary: Boolean(a.primary),
      requiredKeys: [...(a.requiredKeys ?? [])],
      nextTitle: actionTargetTitle(document, nodeId, a.actionId),
    })),
    timeoutNextTitle: actionTargetTitle(document, nodeId, "timeout"),
    hasTimeout: wait.mode === "timeout",
    expiresAt: wait.mode === "timeout" ? Date.now() + wait.timeoutMs : null,
    upstreamFiles,
    upstreamFileManifests,
  };
}

/** 动作端口的去向节点标题（只读记录「选中 › 去向」展示用）。 */
function actionTargetTitle(document, nodeId, portId) {
  const edge = (document?.edges ?? []).find(
    (e) => e.sourceNodeID === nodeId && (e.sourcePortID ?? "") === portId,
  );
  if (!edge) return null;
  const target = document.nodes.find((n) => n.id === edge.targetNodeID);
  return target?.data?.title ?? target?.id ?? null;
}

function upstreamTypeOf(document, nodeId, key) {
  const node = document?.nodes?.find((n) => n.id === nodeId);
  if (!node) return null;
  if (node.type === "hemi-input") {
    const param = (node.data?.parameters ?? []).find((p) => p.key === key);
    return param?.type ?? null;
  }
  if (node.type === "hemi-human-input") {
    const field = (node.data?.fields ?? []).find((f) => f.key === key);
    if (field) return field.type === "text" || field.type === "choice" ? "string" : field.type;
    return key.startsWith("__") ? "string" : null;
  }
  return node.data?.outputSchema?.properties?.[key]?.type ?? null;
}

/**
 * 宿主 executor（注册进 runner 的 executors 表）。
 * @param {object} options
 * @param {Function} [options.verifyArtifact] 与 runner 同一交付核查器（上游文件留 manifest）
 */
export function createHumanInputExecutor({ verifyArtifact = null, log = null } = {}) {
  return {
    type: "hemi-human-input",
    async execute(ctx) {
      const invocation = ctx.invocation ?? {};
      const interaction = await buildInteraction({
        nodeData: ctx.node.data,
        inputs: ctx.inputs,
        document: invocation.documentSnapshot,
        invocationId: ctx.invocationId,
        workflowRunId: ctx.workflowRunId,
        nodeId: ctx.node.id,
        nodeAttemptId: ctx.attemptId,
        verifyFile: verifyArtifact
          ? async (value) =>
              verifyArtifact(value, {
                invocationId: ctx.invocationId,
                nodeId: ctx.node.id,
                key: "content",
                signal: ctx.signal,
              })
          : null,
      });
      log?.info?.(
        `[workflow] 人工输入挂起：${ctx.node.id}（interaction ${interaction.interactionId}${interaction.hasTimeout ? `，期限 ${new Date(interaction.expiresAt).toISOString()}` : "，持续等待"}）`,
      );
      throw workflowError(HUMAN_INPUT_ERROR, "等待人工输入", {
        interaction,
      });
    },
  };
}
