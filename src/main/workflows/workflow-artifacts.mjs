import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { hitsDenyPath } from "../agent/gate/pi-gate.mjs";
const inside = (file, root) =>
  root &&
  (file === root ||
    (!path.relative(root, file).startsWith("..") &&
      !path.isAbsolute(path.relative(root, file))));
export async function verifyWorkflowArtifact(
  value,
  { workspace = null, controlRoot = null, signal = null } = {},
) {
  try {
    if (workspace?.host)
      throw new Error("远端产物需要远端文件核查，不能按本机路径交付");
    const files = Array.isArray(value) ? value : [value];
    if (!files.length) throw new Error("没有交付文件");
    const home = await fs.realpath(os.homedir());
    const cwd = workspace?.dir ? await fs.realpath(workspace.dir) : null;
    const manifests = [];
    for (const file of files) {
      signal?.throwIfAborted();
      if (typeof file !== "string" || !path.isAbsolute(file))
        throw new Error("文件必须是绝对路径");
      const real = await fs.realpath(file);
      if (!inside(real, home) && !inside(real, cwd))
        throw new Error("交付文件不在工作区或家目录中");
      const control = controlRoot ? await fs.realpath(controlRoot) : null;
      if (
        inside(real, control) &&
        !inside(real, path.join(control, "workspace"))
      )
        throw new Error("不可交付 Hemi 控制文件");
      if (hitsDenyPath(real, home) || hitsDenyPath(file, home))
        throw new Error("不可交付受保护文件");
      const handle = await fs.open(real, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("产物不是文件");
        const hash = crypto.createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let position = 0;
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        manifests.push({
          path: real,
          size: stat.size,
          sha256: hash.digest("hex"),
        });
      } finally {
        await handle.close();
      }
    }
    return { ok: true, manifests };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
