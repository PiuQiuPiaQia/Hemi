import {
  Clock3,
  FileText,
  Presentation,
  Plus,
  Trash2,
  Folder,
  Type,
} from "lucide-react";
import type { WorkflowInputParameter } from "@shared/workflow.mjs";
const ruleLabels: Record<string, string> = {
  "last-week": "上一个完整自然周",
  today: "今天",
  yesterday: "昨天",
  "last-month": "上一个完整自然月",
};
const typeLabels: Record<WorkflowInputParameter["type"], string> = {
  string: "文字",
  text: "长文本",
  number: "数字",
  boolean: "是／否",
  enum: "选项",
  date: "日期",
  file: "文件",
  files: "多个文件",
  directory: "文件夹",
};
export function WorkflowInputSchemaForm({
  parameters,
  onChange,
}: {
  parameters: WorkflowInputParameter[];
  onChange: (parameters: WorkflowInputParameter[]) => void;
}) {
  return (
    <section className="h59-input-schema">
      <h4>运行时填写的参数</h4>
      {parameters.map((parameter, index) => {
        const update = (patch: Partial<WorkflowInputParameter>) =>
          onChange(
            parameters.map((value, i) =>
              i === index ? { ...value, ...patch } : value,
            ),
          );
        const Icon =
          parameter.type === "date"
            ? Clock3
            : parameter.type === "enum"
              ? Presentation
              : parameter.type === "directory"
                ? Folder
                : ["file", "files"].includes(parameter.type)
                  ? FileText
                  : Type;
        const preview =
          parameter.type === "date" && parameter.defaultRule
            ? "开始日期、结束日期"
            : parameter.type === "enum"
              ? parameter.options?.join(" / ")
              : parameter.defaultValue != null
                ? String(parameter.defaultValue)
                : typeLabels[parameter.type];
        const hint = parameter.defaultRule
          ? `默认${ruleLabels[parameter.defaultRule] ?? parameter.defaultRule}，启动前可修改。`
          : parameter.defaultValue != null
            ? `默认${String(parameter.defaultValue)}。`
            : "运行时填写。";
        return (
          <details key={index} className="h59-parameter-definition">
            <summary>
              <span className="h59-field-label">
                {parameter.label || parameter.key}
                {parameter.required ? <small>必填</small> : null}
              </span>
              <span className="h59-parameter-binding">
                <Icon aria-hidden="true" />
                <span>{preview}</span>
              </span>
              <span className="h59-hint">{parameter.description || hint}</span>
            </summary>
            <fieldset>
              <label>
                参数名称
                <input
                  value={parameter.label ?? ""}
                  onChange={(event) => update({ label: event.target.value })}
                />
              </label>
              <label>
                参数标识
                <input
                  value={parameter.key}
                  onChange={(event) => update({ key: event.target.value })}
                />
              </label>
              <label>
                参数类型
                <select
                  value={parameter.type}
                  onChange={(event) =>
                    update({
                      type: event.target
                        .value as WorkflowInputParameter["type"],
                      defaultValue: undefined,
                      defaultRule: undefined,
                    })
                  }
                >
                  {Object.entries(typeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                默认值
                {parameter.type === "boolean" ? (
                  <select
                    value={
                      parameter.defaultValue === undefined
                        ? ""
                        : String(parameter.defaultValue)
                    }
                    onChange={(event) =>
                      update({
                        defaultValue:
                          event.target.value === ""
                            ? undefined
                            : event.target.value === "true",
                      })
                    }
                  >
                    <option value="">每次填写</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    type={parameter.type === "number" ? "number" : "text"}
                    value={String(parameter.defaultValue ?? "")}
                    onChange={(event) =>
                      update({
                        defaultValue:
                          event.target.value === ""
                            ? undefined
                            : parameter.type === "number"
                              ? Number(event.target.value)
                              : event.target.value,
                      })
                    }
                  />
                )}
              </label>
              {parameter.type === "date" ? (
                <label>
                  相对日期规则
                  <select
                    value={parameter.defaultRule ?? ""}
                    onChange={(event) =>
                      update({ defaultRule: event.target.value || undefined })
                    }
                  >
                    <option value="">不使用相对日期</option>
                    {Object.entries(ruleLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {parameter.type === "enum" ? (
                <label>
                  选项（每行一个）
                  <textarea
                    value={parameter.options?.join("\n") ?? ""}
                    onChange={(event) =>
                      update({
                        options: event.target.value.split("\n").filter(Boolean),
                      })
                    }
                  />
                </label>
              ) : null}
              <label>
                <span>
                  <input
                    type="checkbox"
                    checked={parameter.required ?? false}
                    onChange={(event) =>
                      update({ required: event.target.checked })
                    }
                  />
                  必填
                </span>
              </label>
              <button
                onClick={() =>
                  onChange(parameters.filter((_, i) => i !== index))
                }
              >
                <Trash2 />
                删除参数
              </button>
            </fieldset>
          </details>
        );
      })}
      <button
        className="h59-add-parameter"
        onClick={() =>
          onChange([
            ...parameters,
            {
              key: `param${parameters.length + 1}`,
              label: "新参数",
              type: "string",
            },
          ])
        }
      >
        <Plus />
        添加参数
      </button>
    </section>
  );
}
