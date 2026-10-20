import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveRelativeDate,
  resolveParameterDefaults,
} from "../../shared/workflow-parameter-defaults.mjs";
import {
  freezeWorkflowModel,
  hydrateWorkflowModel,
} from "./workflow-model-plan.mjs";
import { verifyWorkflowArtifact } from "./workflow-artifacts.mjs";

test("相对日期按明确时区解析跨年上周，准备值冻结而非启动时重算", () => {
  const now = Date.parse("2026-01-05T00:30:00Z");
  assert.equal(
    resolveRelativeDate("上周", { now, timeZone: "Asia/Shanghai" }),
    "2025-12-29～2026-01-04",
  );
  assert.equal(
    resolveRelativeDate("上周", { now, timeZone: "America/Los_Angeles" }),
    "2025-12-22～2025-12-28",
  );
  assert.equal(
    resolveRelativeDate("上周", {
      now: Date.parse("2026-10-12T01:00:00Z"),
      timeZone: "Asia/Shanghai",
    }),
    "2026-10-05～2026-10-11",
  );
  assert.equal(
    resolveRelativeDate("上周", {
      now: Date.parse("2026-10-19T01:00:00Z"),
      timeZone: "Asia/Shanghai",
    }),
    "2026-10-12～2026-10-18",
  );
  const result = resolveParameterDefaults(
    [{ key: "date", type: "date", defaultRule: "last-month" }],
    { now, timeZone: "Asia/Shanghai" },
  );
  assert.equal(result.values.date, "2025-12-01～2025-12-31");
  assert.equal(result.sources.date.resolvedAt, now);
  assert.equal(
    resolveParameterDefaults([{ key: "date", defaultRule: "unknown" }]).issues
      .length,
    1,
  );
});

test("所选模型冻结执行字段而凭据不入档，删除后不能悄悄换默认模型", async () => {
  let deleted = false;
  const store = {
    list: async () => ({
      roleModels: { main: "p/a", fallback: "p/b", fixer: "p/b" },
    }),
    resolveStrict: async (key) =>
      deleted
        ? { ok: false, message: "deleted" }
        : {
            ok: true,
            config: {
              modelKey: key,
              model: key === "p/b" ? "B" : "A",
              api: "openai-completions",
              baseUrl: "https://original",
              apiKey: "private-key",
              supportsVision: true,
            },
          },
  };
  const roles = new Map([["fixer", { name: "fixer", title: "执行" }]]);
  const fixed = await freezeWorkflowModel({
    selection: { mode: "fixed", modelKey: "p/b" },
    store,
    roles,
  });
  assert.equal(fixed.config.model, "B");
  assert.equal(fixed.roleModels.fixer.model, "B");
  assert.equal(fixed.fallback, null);
  assert.ok(!JSON.stringify(fixed).includes("private-key"));
  const auto = await freezeWorkflowModel({
    selection: { mode: "auto" },
    store,
    roles,
  });
  assert.equal(auto.config.model, "A");
  assert.equal(auto.roleModels.fixer.model, "B");
  assert.equal(auto.fallback.model, "B");
  store.resolveStrict = async (key) =>
    deleted
      ? { ok: false, message: "deleted" }
      : {
          ok: true,
          config: {
            modelKey: key,
            model: "CHANGED",
            baseUrl: "https://changed",
            apiKey: "rotated",
          },
        };
  const hydrated = await hydrateWorkflowModel(fixed, store);
  assert.equal(hydrated.config.model, "B");
  assert.equal(hydrated.config.baseUrl, "https://original");
  assert.equal(hydrated.config.apiKey, "rotated");
  deleted = true;
  await assert.rejects(hydrateWorkflowModel(fixed, store), /deleted/);
});

test("真实文件核查拒绝假路径/目录/控制文件，内容变化产生不同指纹", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hemi059-contract-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace/default");
  await fs.mkdir(workspace, { recursive: true });
  const file = path.join(workspace, "report.txt");
  await fs.writeFile(file, "v1");
  const first = await verifyWorkflowArtifact(file, {
    workspace: { dir: workspace },
    controlRoot: root,
  });
  assert.equal(first.ok, true);
  assert.equal(first.manifests[0].size, 2);
  await fs.writeFile(file, "v2");
  const second = await verifyWorkflowArtifact(file, {
    workspace: { dir: workspace },
    controlRoot: root,
  });
  assert.notEqual(second.manifests[0].sha256, first.manifests[0].sha256);
  assert.equal(
    (
      await verifyWorkflowArtifact(path.join(workspace, "missing"), {
        workspace: { dir: workspace },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await verifyWorkflowArtifact(workspace, { workspace: { dir: workspace } }))
      .ok,
    false,
  );
  const control = path.join(root, "secret.json");
  await fs.writeFile(control, "private");
  assert.equal(
    (
      await verifyWorkflowArtifact(control, {
        workspace: { dir: root },
        controlRoot: root,
      })
    ).ok,
    false,
  );
});

test("专用节点只返回成功 JSON 而没有能力调用，不能冒充浏览器/桌面执行完成", async () => {
  const { createWorkflowNodeAgent } =
    await import("../agent/workflow-node-agent.mjs");
  for (const nodeType of ["hemi-browser", "hemi-desktop"]) {
    const agent = createWorkflowNodeAgent({
      session: {
        prompt: async () => ({
          lastText: '{"result":"已完成"}',
          toolNames: [],
        }),
      },
      nodeSpec: {
        nodeType,
        nodeData: {
          goal: "操作目标",
          outputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
          },
        },
      },
    });
    await assert.rejects(
      agent.run(),
      (error) => error.code === "capability-not-used",
    );
  }
});
