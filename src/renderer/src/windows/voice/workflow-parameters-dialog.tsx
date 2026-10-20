import { useState } from "react";
import { Check, Monitor, Play } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ModelProfilesDirectory } from "@/shared/types";
import { ModelSelectorChip } from "./model-selector";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { WorkflowInputParameter } from "@shared/workflow.mjs";

export type PreparedWorkflow = {
  invocationId: string;
  conversationId: string;
  cardId: string;
  draftRevision: number;
  values: Record<string, unknown>;
};
/** Run-specific input editor. The host validates the same input schema again before start. */
export function WorkflowParametersDialog({
  prepared,
  parameters,
  directory,
  currentModelKey,
  onCancel,
  onRun,
  busy,
  error,
  mode = "run",
}: {
  prepared: PreparedWorkflow;
  parameters: WorkflowInputParameter[];
  onCancel: () => void;
  directory: ModelProfilesDirectory | null;
  currentModelKey: string | null;
  onRun: (
    values: Record<string, unknown>,
    modelKey: string | null,
  ) => Promise<void>;
  busy: boolean;
  error?: string;
  mode?: "run" | "prepare";
}) {
  const [values, setValues] = useState(prepared.values);
  const [modelKey, setModelKey] = useState(currentModelKey);
  const set = (key: string, value: unknown) =>
    setValues((old) => ({ ...old, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className="h59-parameters-dialog"
        aria-label={mode === "prepare" ? "修改本次参数" : "本次运行设置"}
      >
        <header>
          <DialogTitle>{mode === "prepare" ? "修改本次参数" : "本次运行设置"}</DialogTitle>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(values, modelKey);
          }}
        >
          <ScrollArea className="h59-parameters-scroll">
            <div className="h59-parameters-body">
              <p className="h59-hint">只用于这次运行，不修改工作流默认输入。</p>
              {!parameters.length ? <p className="h59-hint">本流程无需填写输入，所需内容由执行节点生成。</p> : null}
              {error ? (
                <p role="alert" className="h59-error">
                  {error}
                </p>
              ) : null}
              {parameters.map((parameter) => {
                const value = values[parameter.key];
                const label = parameter.label || parameter.key;
                // The host freezes relative ranges as YYYY-MM-DD～YYYY-MM-DD.
                // Keep that canonical string when editing, rather than coercing it
                // into a single native date input (which silently renders blank).
                const dates =
                  typeof value === "string" ? value.split(/[～~]/) : [];
                const isRange =
                  parameter.type === "date" &&
                  (dates.length === 2 ||
                    parameter.defaultRule === "last-week" ||
                    parameter.defaultRule === "last-month");
                return (
                  <label key={parameter.key}>
                    <span>
                      {label}
                      {parameter.required ? <small>必填</small> : null}
                    </span>
                    {parameter.type === "enum" ? (
                      <select
                        value={String(value ?? "")}
                        required={mode === "run" && parameter.required}
                        onChange={(event) =>
                          set(parameter.key, event.target.value)
                        }
                      >
                        <option value="">请选择</option>
                        {parameter.options?.map((option) => (
                          <option key={option}>{option}</option>
                        ))}
                      </select>
                    ) : parameter.type === "boolean" ? (
                      <select
                        value={value === undefined ? "" : String(value)}
                        required={mode === "run" && parameter.required}
                        onChange={(event) =>
                          set(
                            parameter.key,
                            event.target.value === ""
                              ? undefined
                              : event.target.value === "true",
                          )
                        }
                      >
                        <option value="">请选择</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : isRange ? (
                      <span className="h59-date-range">
                        {([0, 1] as const).map((index) => (
                          <input
                            key={index}
                            aria-label={`${label}${index === 0 ? "开始" : "结束"}`}
                            type="date"
                            required={mode === "run" && parameter.required}
                            value={dates[index] ?? ""}
                            onChange={(event) => {
                              const next = [...dates];
                              next[index] = event.target.value;
                              set(
                                parameter.key,
                                `${next[0] ?? ""}～${next[1] ?? ""}`,
                              );
                            }}
                          />
                        ))}
                      </span>
                    ) : parameter.type === "text" ||
                      parameter.type === "files" ? (
                      <textarea
                        value={
                          Array.isArray(value)
                            ? value.join("\n")
                            : String(value ?? "")
                        }
                        required={mode === "run" && parameter.required}
                        onChange={(event) =>
                          set(
                            parameter.key,
                            parameter.type === "files"
                              ? event.target.value.split("\n").filter(Boolean)
                              : event.target.value,
                          )
                        }
                      />
                    ) : (
                      <input
                        type={
                          parameter.type === "number"
                            ? "number"
                            : parameter.type === "date"
                              ? "date"
                              : "text"
                        }
                        required={mode === "run" && parameter.required}
                        value={String(value ?? "")}
                        onChange={(event) =>
                          set(
                            parameter.key,
                            parameter.type === "number" &&
                              event.target.value !== ""
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      />
                    )}
                    {parameter.description ? (
                      <span className="h59-hint">{parameter.description}</span>
                    ) : null}
                  </label>
                );
              })}
              <div className="h59-parameters-model">
                <span>执行模型</span>
                <ModelSelectorChip
                  directory={directory}
                  currentProfileId={modelKey}
                  onSelect={setModelKey}
                />
                <small>仅用于本次运行。</small>
              </div>
              <div className="h59-parameters-local">
                <Monitor size={16} aria-hidden="true" />
                <span>在这台电脑上运行</span>
              </div>
            </div>
          </ScrollArea>
          <footer>
            <button type="button" disabled={busy} onClick={onCancel}>
              取消
            </button>
            <button
              className="h37-btn h37-btn-primary"
              type="submit"
              disabled={busy}
            >
              {mode === "prepare" ? <Check size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              {mode === "prepare" ? "保存参数" : "补充并运行"}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
