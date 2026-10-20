// 059 v3 视觉稿的脱敏样本，经真实定义仓库保存／发布；不模拟运行状态。
// 仅隔离真机验收 harness 调用，不随产品装配。
export async function prepareDesignSample(service) {
  for (const row of await service.listDefinitions())
    await service.definitionStore.remove(row.workflowId);
  const output = (key) => ({
    type: "object",
    properties: {
      [key]: {
        type: "string",
        description:
          {
            sourceData: "经营数据.csv",
            analysis: "分析结果与图表",
            report: "经营周报",
          }[key] ?? key,
      },
    },
  });
  const ref = (nodeId, key) => ({
    kind: "node-output",
    nodeId,
    key,
    type: "string",
  });
  const node = (id, type, title, description, x, y, data = {}) => ({
    id,
    type,
    meta: { position: { x, y } },
    data: { title, description, goal: description, ...data },
  });
  const document = {
    nodes: [
      node("input", "hemi-input", "输入参数", "", 234, 20, {
        description: "日期范围、交付格式",
        parameters: [
          {
            key: "date",
            label: "日期范围",
            type: "date",
            required: true,
            defaultRule: "last-week",
          },
          {
            key: "format",
            label: "交付格式",
            type: "enum",
            required: true,
            options: ["演示文稿", "文字报告"],
            defaultValue: "演示文稿",
          },
          {
            key: "destination",
            label: "成果位置",
            type: "string",
            defaultValue: "工作 / 经营周报",
          },
        ],
      }),
      node(
        "fetch",
        "hemi-browser",
        "获取经营数据",
        "从经营后台导出本期数据",
        234,
        124,
        {
          targetUrl: "https://business.example.com",
          outputSchema: output("sourceData"),
          acceptance: "文件可以读取，日期范围与本次输入一致。",
        },
      ),
      node(
        "analyze",
        "hemi-skill",
        "分析数据",
        "汇总指标，找出变化与原因",
        234,
        248,
        {
          goal: "分析本期经营数据，汇总收入、订单和转化率，对比上一周期，说明关键变化与可能原因。",
          skillRefs: [{ name: "workflow-fixture" }],
          inputBindings: [ref("fetch", "sourceData")],
          outputSchema: output("analysis"),
          acceptance:
            "包含三项核心指标、环比变化和数据来源；图表与原始数据一致。",
        },
      ),
      node(
        "condition",
        "hemi-condition",
        "选择交付格式",
        "交付格式等于「演示文稿」",
        234,
        384,
        {
          condition: {
            fieldRef: { kind: "parameter", key: "format", type: "enum" },
            operator: "eq",
            value: "演示文稿",
          },
        },
      ),
      node(
        "ppt",
        "hemi-desktop",
        "生成演示文稿",
        "使用周报模板，整理为 8 页",
        76,
        492,
        {
          applicationRef: "com.microsoft.Powerpoint",
          inputBindings: [ref("analyze", "analysis")],
          outputSchema: output("report"),
        },
      ),
      node(
        "text",
        "hemi-agent",
        "生成文字报告",
        "整理为可阅读的 Markdown",
        412,
        492,
        {
          inputBindings: [ref("analyze", "analysis")],
          outputSchema: output("report"),
          acceptance: "包含经营指标、变化分析、图表和后续建议。",
        },
      ),
      node("deliver", "hemi-deliver", "交付周报", "", 234, 628, {
        description: "交付所选路径的文件与摘要",
        summary: "一份经营周报与结论摘要",
        artifacts: [{ label: "经营周报", binding: ref("text", "report") }],
      }),
    ],
    edges: [
      ["input", "fetch"],
      ["fetch", "analyze"],
      ["analyze", "condition"],
      ["condition", "ppt", "yes"],
      ["condition", "text", "else"],
      ["ppt", "deliver"],
      ["text", "deliver"],
    ].map(([sourceNodeID, targetNodeID, sourcePortID]) => ({
      sourceNodeID,
      targetNodeID,
      ...(sourcePortID ? { sourcePortID } : {}),
    })),
  };
  const store = service.definitionStore;
  for (const [workflowId, name, description] of [
    [
      "design-archive",
      "资料整理归档",
      "按内容分类本地资料，统一命名并生成索引。",
    ],
    [
      "design-research",
      "竞品调研报告",
      "搜集公开资料，核对来源，整理对比报告。",
    ],
  ]) {
    const sample = structuredClone(document);
    sample.nodes = sample.nodes.filter((node) =>
      workflowId === "design-research"
        ? ["input", "fetch", "deliver"].includes(node.id)
        : ["input", "text", "deliver"].includes(node.id),
    );
    const entry = sample.nodes.find((node) => node.type === "hemi-input");
    entry.data.parameters =
      workflowId === "design-archive"
        ? [
            {
              key: "directory",
              label: "资料文件夹",
              type: "directory",
              required: true,
            },
          ]
        : [{ key: "topic", label: "调研主题", type: "string", required: true }];
    const task = sample.nodes[1];
    task.data.goal = "";
    sample.edges = [
      { sourceNodeID: "input", targetNodeID: task.id },
      { sourceNodeID: task.id, targetNodeID: "deliver" },
    ];
    await store.saveDraft({ workflowId, name, description, document: sample });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let saved = await store.saveDraft({
    workflowId: "design-weekly",
    name: "经营周报",
    description: "从后台获取数据，分析后生成演示文稿或文字报告。",
    document,
  });
  for (let revision = 0; revision < 3; revision++) {
    if (revision)
      saved = await store.saveDraft({
        workflowId: "design-weekly",
        name: "经营周报",
        document,
      });
    await store.publish({
      workflowId: "design-weekly",
      expectedDraftRevision: saved.draftRevision,
    });
  }
}
