import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AppWindow,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  ImageIcon,
  Presentation,
  RotateCcw,
  Video,
  MoreHorizontal,
} from "lucide-react";
import type {
  MessagePart,
  ResourceActionView,
  ResourceRef,
} from "../types/api.js";
import { useFlow } from "../host/context.js";
import { useResource } from "../host/resource.js";
import { Menu, MenuGroup, MenuSeparator } from "../ui/menu.js";

export const DeliverableContext = createContext<{
  conversationId: string | null;
  onOpen: (artifactId: string) => void;
  onOpenLink: (path: string) => void;
} | null>(null);
type FilePart = Extract<MessagePart, { type: "file-delivery" }>;
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
function iconOf(name: string) {
  if (isImageName(name)) return ImageIcon;
  if (/\.(xlsx?|csv|tsv|ods)$/i.test(name)) return FileSpreadsheet;
  if (/\.(pptx?|odp)$/i.test(name)) return Presentation;
  if (/\.(zip|gz|tar|7z|rar)$/i.test(name)) return FileArchive;
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return Video;
  if (/\.(html?|json|xml|js|ts|py|css)$/i.test(name)) return FileCode2;
  return FileText;
}
const fileKeyOf = (file: FilePart) =>
  JSON.stringify([
    file.conversationId,
    file.resource?.id || file.artifactId || file.linkPath,
  ]);
function fileSize(size?: number) {
  return size == null
    ? ""
    : size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${Math.ceil(size / 1024)} KB`
        : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
function typeLabel(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return isImageName(name)
    ? "图片"
    : /^(xlsx?|csv|tsv|ods)$/.test(extension)
      ? "表格"
      : /^(pptx?|odp)$/.test(extension)
        ? "演示文稿"
        : /^(zip|gz|tar|7z|rar)$/.test(extension)
          ? "压缩文件"
          : /^(mp4|mov|webm|m4v)$/.test(extension)
            ? "视频"
            : /^(html?|json|xml|js|ts|py|css)$/.test(extension)
              ? extension.toUpperCase()
              : extension === "pdf"
                ? "PDF 文档"
                : "文档";
}
export function DeliverableCards({
  files,
  onOpen,
}: {
  files: FilePart[];
  onOpen?: (artifactId: string, name: string) => void;
}) {
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const onResolved = useCallback(
    (key: string, identity: string) =>
      setIdentities((current) =>
        current[key] === identity ? current : { ...current, [key]: identity },
      ),
    [],
  );
  const seen = new Set<string>();
  return (
    <div className="h62-deliverables" aria-label="交付文件">
      {files
        .filter((file) => {
          const key = fileKeyOf(file),
            identity = identities[key] ?? file.resource?.id ?? key;
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        })
        .map((file) => (
          <DeliverableCard
            key={fileKeyOf(file)}
            file={file}
            onOpen={onOpen}
            onResolved={onResolved}
          />
        ))}
    </div>
  );
}
function DeliverableCard({
  file,
  onOpen,
  onResolved,
}: {
  file: FilePart;
  onOpen?: (artifactId: string, name: string) => void;
  onResolved: (key: string, identity: string) => void;
}) {
  const { runtime } = useFlow(),
    legacy = useContext(DeliverableContext);
  const [resolved, setResolved] = useState<{
    key: string;
    ref: ResourceRef;
  } | null>(null);
  const fileKey = JSON.stringify([
    file.resource,
    file.artifactId,
    file.linkPath,
    file.contentVersion,
  ]);
  const resource =
    file.resource ??
    (resolved?.key === fileKey
      ? resolved.ref
      : file.linkPath
        ? null
        : {
            id: `deliverable:${file.artifactId}`,
            version: String(file.contentVersion ?? 0),
          });
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [attempt, setAttempt] = useState(0),
    [resolveError, setResolveError] = useState("");
  const [ratio, setRatio] = useState<{ key: string; value: number } | null>(
      null,
    ),
    [decodeError, setDecodeError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuActions, setMenuActions] = useState<
      readonly ResourceActionView[] | null
    >(null),
    [actionError, setActionError] = useState("");
  const image = isImageName(file.name),
    Icon = iconOf(file.name);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !file.linkPath || file.resource) return;
    let alive = true;
    setResolveError("");
    if (!runtime.can("resolveResource")) {
      setResolveError("当前环境未提供文件解析");
      return;
    }
    void runtime
      .invoke((context) =>
        runtime.host!.resources!.resolve!({ href: file.linkPath! }, context),
      )
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setResolved({ key: fileKey, ref: result.value });
          onResolved(fileKeyOf(file), result.value.id);
        } else setResolveError(result.error.message);
      });
    return () => {
      alive = false;
    };
  }, [runtime, fileKey, visible, attempt]);
  const content = useResource(resource, "thumbnail", visible && image, attempt);
  const src =
    content?.ok && content.value.content.kind === "url"
      ? content.value.content.url
      : null;
  const name = content?.ok
    ? (content.value.metadata?.name ?? file.name)
    : file.name;
  const details = [
    name,
    file.description,
    [
      typeLabel(name),
      fileSize(
        content?.ok ? (content.value.metadata?.size ?? file.size) : file.size,
      ),
    ]
      .filter(Boolean)
      .join(" · "),
    file.host ? `远端 · ${file.host}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const error =
    resolveError ||
    (content && !content.ok ? content.error.message : "") ||
    decodeError;
  useEffect(() => {
    setDecodeError("");
  }, [fileKey, attempt]);
  useEffect(() => {
    if (!menu || !resource) return;
    let alive = true;
    setMenuActions(null);
    if (!runtime.can("resourceActions")) {
      setMenuActions([]);
      return;
    }
    void runtime
      .invoke((context) =>
        runtime.host!.resources!.listActions!({ ref: resource }, context),
      )
      .then((result) => {
        if (alive) {
          setMenuActions(result.ok ? result.value : []);
          if (!result.ok) setActionError(result.error.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [runtime, menu, resource?.id, resource?.version]);
  const act = async (action: ResourceActionView) => {
    setMenu(null);
    setActionError("");
    if (!resource) return;
    const result = await runtime.invoke((context) =>
      runtime.host!.resources!.perform!(
        { ref: resource, actionId: action.id },
        context,
      ),
    );
    if (!runtime.disposed && !result.ok && result.error.code !== "cancelled")
      setActionError(result.error.message);
  };
  const open = () => {
    if (file.linkPath && legacy) legacy.onOpenLink(file.linkPath);
    else if (onOpen) onOpen(file.artifactId, file.name);
    else if (legacy) legacy.onOpen(file.artifactId);
    else
      void runtime.action({
        type: "preview.open",
        targetId: resource?.id ?? file.artifactId,
        target: "resource",
        resource: resource ?? undefined,
        href: file.linkPath,
        name: file.name,
      });
  };
  const openMenu = (point: { x: number; y: number }) => {
    setActionError("");
    setMenu(point);
  };
  return (
    <div
      ref={root}
      className="h62-deliverable-card"
      data-kind={image ? "image" : "file"}
      data-state={error ? "error" : image && !src ? "loading" : "ready"}
      style={
        image
          ? ({
              "--h62-image-ratio": ratio?.key === fileKey ? ratio.value : 1.5,
            } as CSSProperties)
          : undefined
      }
      onContextMenu={(event) => {
        if (!runtime.can("resourceActions")) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="h62-deliverable-open"
        onClick={open}
        disabled={!onOpen && !legacy && !runtime.actionable}
        aria-label={`预览 ${file.name}`}
        title={details}
        onKeyDown={(event) => {
          if (
            runtime.can("resourceActions") &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            openMenu({ x: bounds.left, y: bounds.bottom });
          }
        }}
      >
        {image ? (
          <span className="h62-deliverable-thumbnail" aria-busy={!content}>
            {src && !decodeError ? (
              <img
                src={src}
                alt={file.description || file.name}
                onLoad={(event) =>
                  setRatio({
                    key: fileKey,
                    value:
                      event.currentTarget.naturalWidth /
                      event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setDecodeError("图片无法解码，可重新读取")}
              />
            ) : (
              <>
                <ImageIcon aria-hidden="true" />
                <span>{error ? "图片暂时无法显示" : "图片加载中"}</span>
              </>
            )}
          </span>
        ) : (
          <span className="h62-deliverable-icon">
            <Icon aria-hidden="true" />
          </span>
        )}
        <span className="h62-deliverable-info">
          <span className="h62-deliverable-name">{name}</span>
        </span>
      </button>
      {runtime.can("resourceActions") ? (
        <button
          type="button"
          className="hcf-resource-more"
          aria-label={`更多操作：${file.name}`}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            openMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      ) : null}
      {error ? (
        <div className="h62-deliverable-error" role="status">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RotateCcw aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="h62-deliverable-error" role="status">
          {actionError}
        </div>
      ) : null}
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        placement="fixed"
        position={menu ?? undefined}
      >
        <MenuGroup label="打开方式" />
        <div className="h62-file-applications" aria-busy={menuActions === null}>
          {menuActions
            ?.filter((action) => action.kind !== "reveal")
            .map((action) => (
              <button
                type="button"
                role="menuitem"
                className="h37-menu-item"
                key={action.id}
                disabled={Boolean(action.disabledReason)}
                title={action.disabledReason}
                onClick={() => void act(action)}
              >
                {action.iconUrl ? (
                  <img
                    className="h62-application-icon"
                    src={action.iconUrl}
                    alt=""
                  />
                ) : (
                  <AppWindow aria-hidden="true" />
                )}
                <span className="h62-application-name">{action.label}</span>
                {action.isDefault ? (
                  <small className="h62-application-default">默认</small>
                ) : null}
              </button>
            ))}
          {!menuActions?.length ? (
            <div className="h62-application-note" role="status">
              {menuActions === null ? "正在查找可用程序…" : "没有找到可用程序"}
            </div>
          ) : null}
        </div>
        {menuActions
          ?.filter((action) => action.kind === "reveal")
          .map((action) => (
            <div key={action.id}>
              <MenuSeparator />
              <button
                type="button"
                role="menuitem"
                className="h37-menu-item"
                onClick={() => void act(action)}
                disabled={Boolean(action.disabledReason)}
              >
                <FolderOpen aria-hidden="true" />
                {action.label}
              </button>
            </div>
          ))}
      </Menu>
    </div>
  );
}
