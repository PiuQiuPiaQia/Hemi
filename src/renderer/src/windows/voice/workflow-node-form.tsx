import { WorkflowInputSchemaForm } from "./workflow-input-schema-form";
import { WORKFLOW_NODE_ICONS } from "./workflow-node-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  X,
  Check,
  Plus,
  Trash2,
  Sparkles,
  Globe,
  Monitor,
  GitBranch,
  SlidersHorizontal,
  Package,
  MousePointer2,
  Link2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type {
  WorkflowDocument,
  WorkflowNode,
  WorkflowBinding,
  WorkflowInputParameter,
  HumanInputField,
} from "@shared/workflow.mjs";
import { WORKFLOW_NODE_TYPES } from "@shared/workflow.mjs";
import type { InstalledSkill } from "@/shared/types";
type Data = WorkflowNode["data"];
const CONDITION_LABELS: Record<string, string> = {
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于或等于",
  lt: "小于",
  lte: "小于或等于",
  is_empty: "为空",
  is_not_empty: "不为空",
};
function bindingOptions(document: WorkflowDocument, selectedId: string) {
  const options: Array<{ label: string; value: WorkflowBinding }> = [];
  const upstream = new Set<string>();
  const visit = (id: string) => {
    for (const edge of document.edges.filter((e) => e.targetNodeID === id)) {
      if (!upstream.has(edge.sourceNodeID)) {
        upstream.add(edge.sourceNodeID);
        visit(edge.sourceNodeID);
      }
    }
  };
  visit(selectedId);
  for (const node of document.nodes) {
    if (node.id === selectedId || !upstream.has(node.id)) continue;
    if (node.type === "hemi-input")
      for (const param of node.data.parameters ?? [])
        options.push({
          label: `输入 · ${param.label || param.key}`,
          value: { kind: "parameter", key: param.key, type: param.type },
        });
    else if (node.type === "hemi-human-input")
      for (const field of node.data.fields ?? []) {
        const type =
          field.type === "text" || field.type === "choice"
            ? "string"
            : field.type;
        options.push({
          label: `${field.label || field.key} · ${node.data.title || node.id}`,
          value: { kind: "node-output", nodeId: node.id, key: field.key, type },
        });
      }
    else
      for (const [key, prop] of Object.entries(
        node.data.outputSchema?.properties ?? {},
      ))
        options.push({
          label: `${prop.description || key} · ${node.data.title || node.id}`,
          value: { kind: "node-output", nodeId: node.id, key, type: prop.type },
        });
  }
  return options;
}
export function WorkflowNodeForm({
  chosen,
  advanced = false,
  document,
  skills,
  apps,
  patch,
  replace,
  snapshot,
  onClose,
}: {
  chosen: WorkflowNode;
  advanced?: boolean;
  document: WorkflowDocument;
  skills: InstalledSkill[];
  apps: Array<{ name: string; applicationRef: string }>;
  patch: (data: Partial<Data>) => void;
  replace: (document: WorkflowDocument) => void;
  snapshot: () => WorkflowDocument;
  onClose: () => void;
}) {
  const options = bindingOptions(document, chosen.id);
  const Icon = WORKFLOW_NODE_ICONS[chosen.type];
  const goalLabel =
    chosen.type === "hemi-agent"
      ? "任务目标"
      : chosen.type === "hemi-skill"
        ? "执行说明"
        : "操作说明";
  const goalHint =
    chosen.type === "hemi-agent"
      ? "由 Hemi 根据目标规划步骤，按需调用工具完成任务。"
      : chosen.type === "hemi-skill"
        ? "按所选 Skill 执行，填写本步目标和要求。"
        : chosen.type === "hemi-browser"
          ? "描述在目标网页需要读取或完成的操作。"
          : "描述在目标应用内需要完成的操作。";
  const sourceSelect = (
    value: WorkflowBinding | undefined,
    onChange: (b: WorkflowBinding) => void,
    label = "取值来源",
  ) => (
    <label
      className={label.startsWith("输入 ") ? "h59-binding-control" : undefined}
    >
      <span className={label.startsWith("输入 ") ? "sr-only" : undefined}>
        {label}
      </span>
      {label.startsWith("输入 ") ? <Link2 aria-hidden="true" /> : null}
      {label.startsWith("输入 ") ? (
        <span className="h59-binding-label" aria-hidden="true">
          {options.find(
            (option) => JSON.stringify(option.value) === JSON.stringify(value),
          )?.label || "请选择"}
        </span>
      ) : null}
      <select
        aria-label={label}
        value={value ? JSON.stringify(value) : ""}
        onChange={(e) => {
          if (e.target.value)
            onChange(JSON.parse(e.target.value) as WorkflowBinding);
        }}
      >
        <option value="">请选择</option>
        {options.map((o) => (
          <option key={JSON.stringify(o.value)} value={JSON.stringify(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {label.startsWith("输入 ") ? <ChevronRight aria-hidden="true" /> : null}
    </label>
  );
  const updateParams = (params: WorkflowInputParameter[]) =>
    patch({ parameters: params });
  return (
    <>
      <header className="h59-inspector-heading">
        <span className="h59-node-type">
          <Icon aria-hidden="true" />
        </span>
        <h3>{WORKFLOW_NODE_TYPES[chosen.type].label}节点</h3>
        <button onClick={onClose} aria-label="关闭配置">
          <X />
          <span className="sr-only">关闭配置</span>
        </button>
      </header>
      <ScrollArea className="h59-inspector-scroll">
        <div className="h59-inspector-body" data-node-type={chosen.type}>
          <label>
            名称
            <input
              aria-label="节点名称"
              value={chosen.data.title ?? ""}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>

          {chosen.type === "hemi-skill" ? (
            <label>
              <span>
                调用 Skill <small>必填</small>
              </span>
              <span className="h59-capability-select">
                <Sparkles aria-hidden="true" />
                <select
                  aria-label="调用 Skill"
                  value={chosen.data.skillRefs?.[0]?.name ?? ""}
                  onChange={(e) => {
                    const skill = skills.find((s) => s.name === e.target.value);
                    patch({
                      skillRefs: skill
                        ? [{ name: skill.name, version: skill.version }]
                        : [],
                    });
                  }}
                >
                  <option value="">选择已启用的 Skill</option>
                  {skills.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.title || s.name}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
              <span className="h59-field-hint">
                从已安装的 Skill 中选择，保存时记录版本。
              </span>
            </label>
          ) : null}
          {chosen.type === "hemi-browser" ? (
            <>
              <label>
                <span>
                  目标网址 <small>必填</small>
                </span>
                <input
                  aria-label="目标网址"
                  value={chosen.data.targetUrl ?? ""}
                  onChange={(e) => patch({ targetUrl: e.target.value })}
                />
                <span className="h59-field-hint">
                  通过浏览器连接执行；需要登录时暂停等待。
                </span>
              </label>
              {advanced || chosen.data.targetBinding || !chosen.data.targetUrl
                ? sourceSelect(
                    chosen.data.targetBinding,
                    (b) => patch({ targetBinding: b, targetUrl: "" }),
                    "或从输入取网址",
                  )
                : null}
            </>
          ) : null}
          {chosen.type === "hemi-desktop" ? (
            <label>
              <span>
                目标应用 <small>必填</small>
              </span>
              <select
                aria-label="目标应用"
                value={chosen.data.applicationRef ?? ""}
                onChange={(e) => patch({ applicationRef: e.target.value })}
              >
                <option value="">选择已安装应用</option>
                {chosen.data.applicationRef &&
                !apps.some(
                  (app) => app.applicationRef === chosen.data.applicationRef,
                ) ? (
                  <option value={chosen.data.applicationRef}>
                    {chosen.data.applicationRef}（当前不可用）
                  </option>
                ) : null}
                {apps.map((app) => (
                  <option key={app.applicationRef} value={app.applicationRef}>
                    {app.name}
                  </option>
                ))}
              </select>
              <span className="h59-field-hint">
                通过桌面操控执行，沿用应用授权。
              </span>
            </label>
          ) : null}
          {[
            "hemi-agent",
            "hemi-skill",
            "hemi-browser",
            "hemi-desktop",
          ].includes(chosen.type) ? (
            <label>
              {goalLabel}
              <textarea
                aria-label={goalLabel}
                value={chosen.data.goal ?? ""}
                onChange={(e) => patch({ goal: e.target.value })}
              />
              <span className="h59-field-hint">{goalHint}</span>
            </label>
          ) : null}
          {chosen.type === "hemi-input" ? (
            <WorkflowInputSchemaForm
              parameters={chosen.data.parameters ?? []}
              onChange={updateParams}
            />
          ) : null}
          {[
            "hemi-agent",
            "hemi-skill",
            "hemi-browser",
            "hemi-desktop",
          ].includes(chosen.type) ? (
            <fieldset className="h59-input-sources">
              <legend>输入来源</legend>
              {(chosen.data.inputBindings ?? []).map((b, i, all) => (
                <div key={i}>
                  {sourceSelect(
                    b,
                    (next) =>
                      patch({
                        inputBindings: all.map((x, j) => (i === j ? next : x)),
                      }),
                    `输入 ${i + 1}`,
                  )}
                  <button
                    onClick={() =>
                      patch({ inputBindings: all.filter((_, j) => j !== i) })
                    }
                  >
                    <X aria-hidden="true" />
                    <span className="sr-only">移除输入</span>
                  </button>
                </div>
              ))}
              <button
                disabled={!options.length}
                onClick={() =>
                  patch({
                    inputBindings: [
                      ...(chosen.data.inputBindings ?? []),
                      options[0].value,
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                <span className="sr-only">添加输入</span>
              </button>
            </fieldset>
          ) : null}
          {chosen.data.outputSchema ? (
            <label>
              {chosen.type === "hemi-agent" ? "预期输出" : "预期产物"}
              <input
                aria-label={
                  chosen.type === "hemi-agent" ? "预期输出" : "预期产物"
                }
                value={
                  Object.values(chosen.data.outputSchema.properties)[0]
                    ?.description ?? ""
                }
                placeholder="例如：分析结果与图表"
                onChange={(event) => {
                  const [key, prop] = Object.entries(
                    chosen.data.outputSchema!.properties,
                  )[0] ?? ["result", { type: "string" }];
                  patch({
                    outputSchema: {
                      type: "object",
                      properties: {
                        ...chosen.data.outputSchema!.properties,
                        [key]: { ...prop, description: event.target.value },
                      },
                    },
                  });
                }}
              />
            </label>
          ) : null}
          {[
            "hemi-agent",
            "hemi-skill",
            "hemi-browser",
            "hemi-desktop",
          ].includes(chosen.type) ? (
            <label>
              完成条件
              <textarea
                className="h59-short-control"
                aria-label="完成条件"
                value={chosen.data.acceptance ?? ""}
                onChange={(e) => patch({ acceptance: e.target.value })}
              />
            </label>
          ) : null}

          {chosen.type === "hemi-condition" ? (
            <fieldset>
              <legend>条件</legend>
              {sourceSelect(
                chosen.data.condition?.fieldRef,
                (b) =>
                  patch({
                    condition: { ...chosen.data.condition!, fieldRef: b },
                  }),
                "判断内容",
              )}
              <label>
                比较方式
                <select
                  value={chosen.data.condition?.operator ?? "eq"}
                  onChange={(e) =>
                    patch({
                      condition: {
                        ...chosen.data.condition!,
                        operator: e.target.value,
                      },
                    })
                  }
                >
                  {[
                    "eq",
                    "neq",
                    "gt",
                    "gte",
                    "lt",
                    "lte",
                    "is_empty",
                    "is_not_empty",
                  ].map((o) => (
                    <option key={o} value={o}>
                      {CONDITION_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                比较值
                {chosen.data.condition?.fieldRef.kind === "parameter" &&
                document.nodes
                  .find((node) => node.type === "hemi-input")
                  ?.data.parameters?.find(
                    (parameter) =>
                      parameter.key === chosen.data.condition?.fieldRef.key,
                  )?.type === "enum" ? (
                  <select
                    value={String(chosen.data.condition?.value ?? "")}
                    onChange={(event) =>
                      patch({
                        condition: {
                          ...chosen.data.condition!,
                          value: event.target.value,
                        },
                      })
                    }
                  >
                    {document.nodes
                      .find((node) => node.type === "hemi-input")
                      ?.data.parameters?.find(
                        (parameter) =>
                          parameter.key === chosen.data.condition?.fieldRef.key,
                      )
                      ?.options?.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                  </select>
                ) : chosen.data.condition?.fieldRef.type === "boolean" ? (
                  <select
                    value={
                      chosen.data.condition.value === undefined
                        ? ""
                        : String(chosen.data.condition.value)
                    }
                    onChange={(e) =>
                      patch({
                        condition: {
                          ...chosen.data.condition!,
                          value:
                            e.target.value === ""
                              ? undefined
                              : e.target.value === "true",
                        },
                      })
                    }
                  >
                    <option value="">请选择</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    type={
                      chosen.data.condition?.fieldRef.type === "number"
                        ? "number"
                        : "text"
                    }
                    value={String(chosen.data.condition?.value ?? "")}
                    onChange={(e) =>
                      patch({
                        condition: {
                          ...chosen.data.condition!,
                          value:
                            chosen.data.condition?.fieldRef.type === "number"
                              ? e.target.value === ""
                                ? undefined
                                : Number(e.target.value)
                              : e.target.value,
                        },
                      })
                    }
                  />
                )}
              </label>
            </fieldset>
          ) : null}
          {chosen.type === "hemi-human-input" ? (
            <div className="h59-hi-node-form">
              <label>
                展示内容（可插入{"{{节点.输出}}" as const} 变量）
                <textarea
                  className="h59-short-control"
                  aria-label="展示内容"
                  value={chosen.data.content ?? ""}
                  onChange={(e) => patch({ content: e.target.value })}
                />
              </label>
              {options.length > 0 ? (
                <div className="h59-hi-vars">
                  <span>插入变量：</span>
                  {options.map((option) => {
                    const inputNodeId = document.nodes.find(
                      (node) => node.type === "hemi-input",
                    )?.id;
                    const nodeId =
                      option.value.kind === "parameter"
                        ? inputNodeId
                        : option.value.nodeId;
                    const key =
                      option.value.kind === "parameter"
                        ? option.value.key
                        : option.value.key;
                    if (!nodeId) return null;
                    return (
                      <button
                        key={`${nodeId}.${key}`}
                        onClick={() =>
                          patch({
                            content: `${chosen.data.content ?? ""}{{${nodeId}.${key}}}`,
                          })
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <fieldset>
                <legend>收集输入（{(chosen.data.fields ?? []).length} 个字段，可为 0）</legend>
                {(chosen.data.fields ?? []).map((field, index, all) => (
                  <div key={field.fieldId ?? field.key} className="h59-hi-field-row">
                    <label>
                      类型
                      <select
                        aria-label={`字段 ${field.key} 类型`}
                        value={field.type}
                        onChange={(e) =>
                          patch({
                            fields: all.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    type: e.target.value as HumanInputField["type"],
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="text">多行文本</option>
                        <option value="choice">单选</option>
                        <option value="file">单文件</option>
                        <option value="files">多文件</option>
                      </select>
                    </label>
                    <label>
                      名称
                      <input
                        aria-label={`字段 ${field.key} 名称`}
                        value={field.label ?? ""}
                        onChange={(e) =>
                          patch({
                            fields: all.map((item, i) =>
                              i === index ? { ...item, label: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      输出变量
                      <input
                        aria-label={`字段 ${field.key} 输出变量`}
                        value={field.key}
                        onChange={(e) =>
                          patch({
                            fields: all.map((item, i) =>
                              i === index ? { ...item, key: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="h59-hi-check">
                      <input
                        type="checkbox"
                        checked={Boolean(field.required)}
                        aria-label={`字段 ${field.key} 必填`}
                        onChange={(e) =>
                          patch({
                            fields: all.map((item, i) =>
                              i === index
                                ? { ...item, required: e.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      必填
                    </label>
                    {field.type === "choice" ? (
                      <div className="h59-hi-choice-source">
                        <label className="h59-hi-check">
                          <input
                            type="checkbox"
                            checked={Boolean(field.config?.optionsBinding)}
                            aria-label={`字段 ${field.key} 用上游列表`}
                            onChange={(e) =>
                              patch({
                                fields: all.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        config: {
                                          ...item.config,
                                          optionsBinding: e.target.checked
                                            ? (options.find(
                                                  (option) =>
                                                    option.value.type === "array",
                                              )?.value ?? undefined)
                                            : undefined,
                                        },
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                          选项来自上游列表
                        </label>
                        {field.config?.optionsBinding ? (
                          sourceSelect(
                            field.config.optionsBinding,
                            (binding) =>
                              patch({
                                fields: all.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        config: { ...item.config, optionsBinding: binding },
                                      }
                                    : item,
                                ),
                              }),
                            `字段 ${field.key} 选项来源`,
                          )
                        ) : (
                          <label>
                            选项（每行一个）
                            <textarea
                              aria-label={`字段 ${field.key} 选项`}
                              value={(field.config?.options ?? []).join("\n")}
                              onChange={(e) =>
                                patch({
                                  fields: all.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          config: {
                                            ...item.config,
                                            options: e.target.value.split("\n"),
                                          },
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </label>
                        )}
                      </div>
                    ) : null}
                    {field.type === "text" ? (
                      <div className="h59-hi-choice-source">
                        <label className="h59-hi-check">
                          <input
                            type="checkbox"
                            checked={Boolean(field.config?.prefillBinding)}
                            aria-label={`字段 ${field.key} 用上游预填`}
                            onChange={(e) =>
                              patch({
                                fields: all.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        config: {
                                          ...item.config,
                                          prefillBinding: e.target.checked
                                            ? (options.find(
                                                  (option) =>
                                                    option.value.type === "string",
                                              )?.value ?? undefined)
                                            : undefined,
                                        },
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                          预填来自上游
                        </label>
                        {field.config?.prefillBinding ? (
                          sourceSelect(
                            field.config.prefillBinding,
                            (binding) =>
                              patch({
                                fields: all.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        config: { ...item.config, prefillBinding: binding },
                                      }
                                    : item,
                                ),
                              }),
                            `字段 ${field.key} 预填来源`,
                          )
                        ) : (
                          <label>
                            预填文本
                            <input
                              aria-label={`字段 ${field.key} 预填文本`}
                              value={field.config?.prefillText ?? ""}
                              onChange={(e) =>
                                patch({
                                  fields: all.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          config: {
                                            ...item.config,
                                            prefillText: e.target.value,
                                          },
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </label>
                        )}
                      </div>
                    ) : null}
                    <button
                      className="h59-hi-remove"
                      onClick={() =>
                        patch({ fields: all.filter((_, i) => i !== index) })
                      }
                    >
                      <X aria-hidden="true" />
                      <span className="sr-only">删除字段 {field.key}</span>
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    patch({
                      fields: [
                        ...(chosen.data.fields ?? []),
                        {
                          fieldId: `f-${crypto.randomUUID().slice(0, 6)}`,
                          key: `field_${(chosen.data.fields ?? []).length + 1}`,
                          label: "",
                          type: "text",
                          required: false,
                          config: {},
                        },
                      ],
                    })
                  }
                >
                  <Plus aria-hidden="true" />
                  添加字段
                </button>
              </fieldset>
              <fieldset>
                <legend>操作与分支（每个操作一个输出端口）</legend>
                {(chosen.data.actions ?? []).map((action, index, all) => (
                  <div key={action.actionId} className="h59-hi-field-row">
                    <label>
                      按钮文案
                      <input
                        aria-label={`操作 ${action.actionId} 按钮文案`}
                        value={action.label}
                        onChange={(e) =>
                          patch({
                            actions: all.map((item, i) =>
                              i === index ? { ...item, label: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      操作 ID（端口名）
                      <input
                        aria-label={`操作 ${action.actionId} ID`}
                        value={action.actionId}
                        onChange={(e) =>
                          patch({
                            actions: all.map((item, i) =>
                              i === index ? { ...item, actionId: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="h59-hi-check">
                      <input
                        type="radio"
                        name={`h59-hi-primary-${chosen.id}`}
                        checked={Boolean(action.primary)}
                        aria-label={`${action.label} 设为主按钮`}
                        onChange={(e) =>
                          patch({
                            actions: all.map((item, i) => ({
                              ...item,
                              primary: i === index ? e.target.checked : false,
                            })),
                          })
                        }
                      />
                      主按钮
                    </label>
                    {(chosen.data.fields ?? []).length > 0 ? (
                      <div className="h59-hi-required-keys">
                        <span>该操作额外必填：</span>
                        {(chosen.data.fields ?? []).map((field) => (
                          <label key={field.key} className="h59-hi-check">
                            <input
                              type="checkbox"
                              checked={(action.requiredKeys ?? []).includes(field.key)}
                              aria-label={`${action.label} 必填 ${field.key}`}
                              onChange={(e) =>
                                patch({
                                  actions: all.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          requiredKeys: e.target.checked
                                            ? [...(item.requiredKeys ?? []), field.key]
                                            : (item.requiredKeys ?? []).filter(
                                                (key) => key !== field.key,
                                              ),
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                            {field.label || field.key}
                          </label>
                        ))}
                      </div>
                    ) : null}
                    <button
                      className="h59-hi-remove"
                      disabled={all.length <= 1}
                      onClick={() =>
                        patch({ actions: all.filter((_, i) => i !== index) })
                      }
                    >
                      <X aria-hidden="true" />
                      <span className="sr-only">删除操作 {action.actionId}</span>
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    patch({
                      actions: [
                        ...(chosen.data.actions ?? []),
                        {
                          actionId: `action_${(chosen.data.actions ?? []).length + 1}`,
                          label: "新操作",
                          primary: false,
                          requiredKeys: [],
                        },
                      ],
                    })
                  }
                >
                  <Plus aria-hidden="true" />
                  添加操作
                </button>
              </fieldset>
              <fieldset>
                <legend>等待</legend>
                <label>
                  等待方式
                  <select
                    aria-label="等待方式"
                    value={chosen.data.wait?.mode ?? "forever"}
                    onChange={(e) =>
                      patch({
                        wait:
                          e.target.value === "timeout"
                            ? { mode: "timeout", timeoutMs: 24 * 60 * 60 * 1000 }
                            : { mode: "forever" },
                      })
                    }
                  >
                    <option value="forever">持续等待，直到有人提交</option>
                    <option value="timeout">设时限，超时走独立分支</option>
                  </select>
                </label>
                {chosen.data.wait?.mode === "timeout" ? (
                  <label>
                    等待时限（分钟）
                    <input
                      type="number"
                      min={1}
                      aria-label="等待时限（分钟）"
                      value={Math.max(
                        1,
                        Math.round((chosen.data.wait.timeoutMs ?? 0) / 60000),
                      )}
                      onChange={(e) =>
                        patch({
                          wait: {
                            mode: "timeout",
                            timeoutMs: Math.max(1, Number(e.target.value) || 1) * 60000,
                          },
                        })
                      }
                    />
                  </label>
                ) : null}
              </fieldset>
            </div>
          ) : null}
          {chosen.type === "hemi-deliver" && !advanced ? (
            <div className="h59-delivery-form">
              <fieldset className="h59-input-sources">
                <legend>交付内容</legend>
                {(chosen.data.artifacts ?? []).map((artifact, index, all) => (
                  <div key={index}>
                    {sourceSelect(
                      artifact.binding,
                      (binding) =>
                        patch({
                          artifacts: all.map((item, i) =>
                            i === index ? { ...item, binding } : item,
                          ),
                        }),
                      `输入 交付来源 ${index + 1}`,
                    )}
                  </div>
                ))}
                <p className="h59-field-hint">
                  交付已绑定来源的实际产物；未执行的路径不会产生文件。
                </p>
              </fieldset>
              <label>
                结果说明
                <textarea
                  className="h59-delivery-summary"
                  aria-label="结果说明"
                  value={chosen.data.summary ?? ""}
                  onChange={(event) => patch({ summary: event.target.value })}
                />
              </label>
              <section className="h59-delivery-checks">
                <h4>交付前检查</h4>
                <p>
                  <Check aria-hidden="true" />
                  来源已完成且产物类型符合声明
                </p>
                <p>
                  <Check aria-hidden="true" />
                  文件存在且可以读取
                </p>
                <span className="h59-field-hint">
                  运行时校验；不会把尚未生成的文件显示为已交付。
                </span>
              </section>
            </div>
          ) : null}
          {chosen.type === "hemi-deliver" && advanced ? (
            <fieldset>
              <legend>交付内容</legend>
              <label>
                交付说明
                <textarea
                  value={chosen.data.summary ?? ""}
                  onChange={(e) => patch({ summary: e.target.value })}
                />
              </label>
              {(chosen.data.artifacts ?? []).map((a, i, all) => (
                <div key={i}>
                  <label>
                    结果名称
                    <input
                      value={a.label ?? ""}
                      onChange={(e) =>
                        patch({
                          artifacts: all.map((x, j) =>
                            i === j ? { ...x, label: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  {sourceSelect(
                    a.binding,
                    (b) =>
                      patch({
                        artifacts: all.map((x, j) =>
                          i === j ? { ...x, binding: b } : x,
                        ),
                      }),
                    `交付来源 ${i + 1}`,
                  )}
                  <button
                    onClick={() =>
                      patch({ artifacts: all.filter((_, j) => j !== i) })
                    }
                  >
                    移除交付
                  </button>
                </div>
              ))}
              <button
                disabled={!options.length}
                onClick={() =>
                  patch({
                    artifacts: [
                      ...(chosen.data.artifacts ?? []),
                      {
                        label: `结果${(chosen.data.artifacts?.length ?? 0) + 1}`,
                        binding: options[0].value,
                      },
                    ],
                  })
                }
              >
                添加交付
              </button>
            </fieldset>
          ) : null}
          {chosen.type !== "hemi-deliver" &&
          (advanced ||
            ["hemi-condition", "hemi-human-input"].includes(chosen.type)) ? (
            <details
              className="h59-connection-options"
              open={
                ["hemi-condition", "hemi-human-input"].includes(chosen.type)
                  ? true
                  : undefined
              }
            >
              <summary>
                {chosen.type === "hemi-condition"
                  ? "执行路径"
                  : chosen.type === "hemi-human-input"
                    ? "操作去向"
                    : "连接与下一步"}
              </summary>
              <fieldset>
                <legend>下一步</legend>
                {(chosen.type === "hemi-condition"
                  ? ["yes", "else"]
                  : chosen.type === "hemi-human-input"
                    ? [
                        ...(chosen.data.actions ?? []).map((a) => a.actionId),
                        ...(chosen.data.wait?.mode === "timeout"
                          ? ["timeout"]
                          : []),
                      ]
                    : [""]
                ).map((port) => (
                  <label key={port}>
                    {chosen.type === "hemi-human-input" && port
                      ? `${
                          chosen.data.actions?.find((a) => a.actionId === port)
                            ?.label ?? port
                        }（${port === "timeout" ? "超时" : port}）`
                      : port === "yes"
                        ? "符合条件"
                        : port === "else"
                          ? "不符合条件"
                          : "执行后进入"}
                    <select
                      value={
                        document.edges.find(
                          (e) =>
                            e.sourceNodeID === chosen.id &&
                            (e.sourcePortID ?? "") === port,
                        )?.targetNodeID ?? ""
                      }
                      onChange={(e) => {
                        const graph = snapshot();
                        replace({
                          ...graph,
                          edges: [
                            ...graph.edges.filter(
                              (x) =>
                                !(
                                  x.sourceNodeID === chosen.id &&
                                  (x.sourcePortID ?? "") === port
                                ),
                            ),
                            ...(e.target.value
                              ? [
                                  {
                                    sourceNodeID: chosen.id,
                                    targetNodeID: e.target.value,
                                    ...(port ? { sourcePortID: port } : {}),
                                  },
                                ]
                              : []),
                          ],
                        });
                      }}
                    >
                      <option value="">未连接</option>
                      {document.nodes
                        .filter(
                          (n) => n.id !== chosen.id && n.type !== "hemi-input",
                        )
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.data.title || n.id}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </fieldset>
            </details>
          ) : null}
          {advanced ? (
            <>
              <details className="h59-layout-options">
                <summary>节点位置（键盘移动）</summary>
                <fieldset>
                  <legend>节点位置（键盘移动）</legend>
                  {(["x", "y"] as const).map((axis) => (
                    <label key={axis}>
                      {axis === "x" ? "水平位置" : "垂直位置"}
                      <input
                        type="number"
                        aria-label={axis === "x" ? "水平位置" : "垂直位置"}
                        value={chosen.meta.position[axis]}
                        onChange={(e) => {
                          const graph = snapshot();
                          replace({
                            ...graph,
                            nodes: graph.nodes.map((n) =>
                              n.id === chosen.id
                                ? {
                                    ...n,
                                    meta: {
                                      ...n.meta,
                                      position: {
                                        ...n.meta.position,
                                        [axis]: Number(e.target.value),
                                      },
                                    },
                                  }
                                : n,
                            ),
                          });
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              </details>
              <details className="h59-advanced-options">
                <summary>高级配置</summary>
                <label>
                  节点摘要
                  <input
                    value={chosen.data.description ?? ""}
                    onChange={(event) =>
                      patch({ description: event.target.value })
                    }
                  />
                </label>
                <section className="h59-schema-options">
                  <h4>输出字段与类型</h4>
                  {chosen.data.outputSchema ? (
                    <fieldset>
                      <legend>输出字段</legend>
                      {Object.entries(chosen.data.outputSchema.properties).map(
                        ([key, prop]) => (
                          <div key={key}>
                            <label>
                              字段标识
                              <input
                                defaultValue={key}
                                onBlur={(e) => {
                                  const properties = {
                                    ...chosen.data.outputSchema!.properties,
                                  };
                                  delete properties[key];
                                  properties[e.target.value] = prop;
                                  patch({
                                    outputSchema: {
                                      type: "object",
                                      properties,
                                    },
                                  });
                                }}
                              />
                            </label>
                            <label>
                              字段类型
                              <select
                                value={prop.type}
                                onChange={(e) =>
                                  patch({
                                    outputSchema: {
                                      type: "object",
                                      properties: {
                                        ...chosen.data.outputSchema!.properties,
                                        [key]: {
                                          ...prop,
                                          type: e.target.value,
                                        },
                                      },
                                    },
                                  })
                                }
                              >
                                {[
                                  "string",
                                  "number",
                                  "boolean",
                                  "file",
                                  "files",
                                ].map((t) => (
                                  <option key={t}>{t}</option>
                                ))}
                              </select>
                            </label>
                            <button
                              onClick={() => {
                                const properties = {
                                  ...chosen.data.outputSchema!.properties,
                                };
                                delete properties[key];
                                patch({
                                  outputSchema: { type: "object", properties },
                                });
                              }}
                            >
                              删除字段
                            </button>
                          </div>
                        ),
                      )}
                      <button
                        onClick={() =>
                          patch({
                            outputSchema: {
                              type: "object",
                              properties: {
                                ...chosen.data.outputSchema!.properties,
                                [`output${Object.keys(chosen.data.outputSchema!.properties).length + 1}`]:
                                  { type: "string" },
                              },
                            },
                          })
                        }
                      >
                        添加输出
                      </button>
                    </fieldset>
                  ) : null}
                </section>
              </details>
            </>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="h59-inspector-footer">
        <span>修改后点击顶部保存</span>
        {!["hemi-input", "hemi-deliver"].includes(chosen.type) ? (
          <button
            onClick={() => {
              const graph = snapshot();
              replace({
                nodes: graph.nodes.filter((n) => n.id !== chosen.id),
                edges: graph.edges.filter(
                  (e) =>
                    e.sourceNodeID !== chosen.id &&
                    e.targetNodeID !== chosen.id,
                ),
              });
              onClose();
            }}
          >
            <Trash2 aria-hidden="true" />
            <span className="sr-only">删除节点</span>
          </button>
        ) : null}
      </footer>
    </>
  );
}
