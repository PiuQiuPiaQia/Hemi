"use client";

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { MarkdownCacheContext } from "./markdown-cache-context.js";
import { remarkCachedParser } from "./markdown-parse-cache.js";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Nodes, Root } from "mdast";
import { RotateCcw } from "lucide-react";

import { useFlow } from "../host/context.js";
import { useResource } from "../host/resource.js";
import { boundAutolink } from "./autolink-boundary.js";
import { decodeFileHref, inlineFilePath } from "./local-file-link.js";

/** 自动链接的子节点是纯文本；富文本子节点（元素）返回空串＝按显式链接处理。 */
function flattenLinkText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenLinkText).join("");
  return "";
}

function markInlineFileLinks() {
  return (tree: Root) => {
    const visit = (node: Nodes, inLink = false) => {
      if (node.type === "inlineCode" && !inLink && inlineFilePath(node.value)) {
        node.data = {
          ...node.data,
          hProperties: { "data-hemi-file-path": "true" },
        };
      }
      if (node.type === "image" && inLink) {
        node.data = {
          ...node.data,
          hProperties: { "data-hemi-in-link": "true" },
        };
      }
      if ("children" in node)
        for (const child of node.children)
          visit(
            child,
            inLink || node.type === "link" || node.type === "linkReference",
          );
    };
    visit(tree);
  };
}

/**
 * Hemi 回应的 Markdown 渲染。react-markdown 默认不解析内嵌 HTML，
 * 链接统一交给主进程的 allowlist 外部打开，渲染层不自行导航。
 *
 * 050 R-09/R-21：正文图片分两类——
 *  - 远程 https：浏览器直接加载，失败原位占位＋重试，不静默留白；
 *  - 本地路径：062 对话入口复用 onLocalLink，经宿主查证后在右侧查看；
 *    旧任务结果仍由 resolveImage 映射登记产物，受控读取缩略图。
 */
export type MarkdownImageRef = { taskId: string; artifactId: string } | null;

export const Markdown = memo(function Markdown({
  text,
  resolveImage,
  wrapTables,
  onLocalLink,
}: {
  text: string;
  /** 无会话链接入口时，本地图片路径 → 任务登记产物；缺省不直接读取。 */
  resolveImage?: (src: string) => MarkdownImageRef;
  /** 050：表格包一层横向滚动容器（表宽铺满阅读宽；稿 .table-wrap 口径）。 */
  wrapTables?: boolean;
  /** 062：显式本地文件链接点击（宿主受控解析后进右侧预览）；缺省＝本地链接不可点（不进网页打开器）。 */
  onLocalLink?: (href: string) => void;
}) {
  const cache = useContext(MarkdownCacheContext);
  const { runtime } = useFlow();
  const [linkError, setLinkError] = useState("");
  const openContentLink = (url: string) => {
    if (!runtime.can("openLink")) {
      setLinkError("当前环境未提供链接打开");
      return;
    }
    void runtime
      .invoke((context) => runtime.host!.openLink!({ url }, context))
      .then((result) => {
        if (!runtime.disposed && !result.ok) setLinkError(result.error.message);
      });
  };
  const plugins = useMemo(
    () =>
      [
        remarkGfm,
        markInlineFileLinks,
        [remarkCachedParser, cache],
      ] as import("unified").PluggableList,
    [cache],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={(url) =>
          /^file:\/\//i.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          code: ({ children, node, className, ...props }) => {
            const value = flattenLinkText(children);
            // 只标记行内代码；代码块和已有链接里的代码不能变成嵌套按钮。
            const local =
              node?.properties["data-hemi-file-path"] === "true"
                ? inlineFilePath(value)
                : null;
            return local && onLocalLink ? (
              <button
                type="button"
                className="h62-code-link"
                title={`预览 ${value}`}
                onClick={() => onLocalLink(local)}
              >
                <code>{children}</code>
              </button>
            ) : (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          ...(wrapTables
            ? {
                table: ({ children }) => (
                  <div
                    className="table-wrap"
                    role="region"
                    aria-label="表格"
                    tabIndex={0}
                  >
                    <table>{children}</table>
                  </div>
                ),
              }
            : {}),
          a: ({ href, children }) => {
            // GFM 自动链接会把中文句子里裸 URL 后面的全角收尾标点吞进目标
            // （%EF%BC%89＝「）」）：「文本即网址」的自动链接两边同步剥掉，
            // 显式链接照作者写法（2026-10-11 审计 A2）。
            const linkText = flattenLinkText(children);
            const bounded =
              typeof href === "string" ? boundAutolink(href, linkText) : null;
            const finalHref = bounded?.href ?? href;
            // 062 R-02：非网页链接是本地文件——经宿主受控解析进右侧预览，
            // 绝不落进只接受 http/https 的浏览器打开通道。
            const localHref =
              typeof finalHref === "string" &&
              finalHref &&
              !/^(?:(?:https?|mailto|tel):|#)/i.test(finalHref)
                ? decodeFileHref(finalHref)
                : null;
            return (
              <a
                href={finalHref}
                target="_blank"
                rel="noreferrer"
                className={localHref ? "h62-local-link" : undefined}
                onClick={(event) => {
                  if (!finalHref) return;
                  event.preventDefault();
                  if (localHref) {
                    onLocalLink?.(localHref);
                    return;
                  }
                  // 056：内容链接（模型给出、域名不可预知）任意 http/https 交默认浏览器。
                  openContentLink(String(finalHref));
                }}
              >
                {bounded && bounded.text !== linkText ? bounded.text : children}
              </a>
            );
          },
          img: ({ src, alt, node }) => (
            <MarkdownImage
              src={typeof src === "string" ? src : ""}
              alt={typeof alt === "string" ? alt : ""}
              resolveImage={resolveImage}
              onLocalLink={onLocalLink}
              inLink={node?.properties["data-hemi-in-link"] === "true"}
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {linkError ? (
        <span role="status" className="h62-deliverable-error">
          {linkError}
        </span>
      ) : null}
    </div>
  );
});

/** 失败缩略图（稿 .thumb[data-state=error]）：名称「无法显示」＋原因＋重新读取。 */
function ImageFailure({
  alt,
  reason,
  onRetry,
}: {
  alt: string;
  reason: string;
  onRetry: (() => void) | null;
}) {
  // span 结构：react-markdown 把图片渲染在 <p> 内，figure 嵌套不合法。
  return (
    <span className="h50-thumb" data-state="error" role="note">
      <span className="h50-thumb-err-title">{alt || "图片"} 无法显示</span>
      <span className="h50-thumb-err-reason">{reason}</span>
      {onRetry ? (
        <button type="button" className="h50-act" onClick={onRetry}>
          <RotateCcw className="h50-ic-sm" aria-hidden="true" />
          重新读取
        </button>
      ) : null}
    </span>
  );
}

/** 远程图片：缩略图内直接加载，onError 原位占位＋重试。 */
function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  if (failed) {
    return (
      <ImageFailure
        alt={alt}
        reason="网络图片加载失败（可能已下线或需要登录）"
        onRetry={() => {
          setFailed(false);
          setNonce((value) => value + 1);
        }}
      />
    );
  }
  return (
    <span className="h50-thumb" data-state="ok">
      <img src={src} alt={alt} key={nonce} onError={() => setFailed(true)} />
      {alt ? <span className="h50-thumb-cap">{alt}</span> : null}
    </span>
  );
}

/** 本地登记图片：受控读取的加载中/成功/失败三态。 */
function ArtifactImage({
  taskId,
  artifactId,
  alt,
}: {
  taskId: string;
  artifactId: string;
  alt: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const content = useResource(
    { id: `task-artifact:${taskId}:${artifactId}`, version: "0" },
    "thumbnail",
    true,
    attempt,
  );
  if (!content)
    return (
      <span
        className="h50-thumb"
        data-state="loading"
        aria-label="图片加载中"
      />
    );
  if (!content.ok || content.value.content.kind !== "url")
    return (
      <ImageFailure
        alt={alt}
        reason={!content.ok ? content.error.message : "图片格式不可用"}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  return (
    <span className="h50-thumb" data-state="ok">
      <img src={content.value.content.url} alt={alt} />
      {alt ? <span className="h50-thumb-cap">{alt}</span> : null}
    </span>
  );
}

function MarkdownImage({
  src,
  alt,
  resolveImage,
  onLocalLink,
  inLink,
}: {
  src: string;
  alt: string;
  resolveImage?: (src: string) => MarkdownImageRef;
  onLocalLink?: (href: string) => void;
  inLink?: boolean;
}) {
  if (/^https?:\/\//i.test(src)) return <RemoteImage src={src} alt={alt} />;
  // react-markdown 的 urlTransform 会把非 ASCII 路径百分号编码——本地路径
  // 解码后再交给任务内解析（登记路径是原文）。
  let local = src;
  try {
    // file URL 的百分号由宿主 URL 解析一次，避免路径中的 % 被重复解码。
    local =
      onLocalLink && /^file:\/\//i.test(src) ? src : decodeURIComponent(src);
  } catch {
    /* 已是原文 */
  }
  // 062：主回复没有子任务 taskId；本地图片与普通文件链接走同一受控入口，
  // 不依赖任务产物登记，也不把正文路径自动登记为正式交付。
  if (onLocalLink && local) {
    const label = alt || local.split(/[/\\]/).pop() || "查看图片";
    // Markdown 允许 [![图片](本地路径)](目标)，保留外层链接的点击语义。
    if (inLink) return <span>{label}</span>;
    return (
      <a
        href={src}
        className="h62-local-link"
        data-hemi-local-image="true"
        title={`预览 ${label}`}
        onClick={(event) => {
          event.preventDefault();
          onLocalLink(local);
        }}
      >
        {label}
      </a>
    );
  }
  const ref = resolveImage?.(local) ?? null;
  if (!ref) {
    return (
      <ImageFailure
        alt={alt}
        reason="本地图片不在本任务登记的文件里，无法解析"
        onRetry={null}
      />
    );
  }
  return (
    <ArtifactImage taskId={ref.taskId} artifactId={ref.artifactId} alt={alt} />
  );
}
