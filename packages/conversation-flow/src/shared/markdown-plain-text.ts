import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);
/** Only used by an explicit cross-row copy, never during scroll/render. */
export function markdownPlainText(text: string): string {
  const visit = (node: Nodes): string => {
    if ("value" in node) return String(node.value);
    if (node.type === "image" || node.type === "imageReference")
      return node.alt ?? "";
    if (node.type === "break") return "\n";
    if (!("children" in node)) return "";
    const separator =
      node.type === "tableRow"
        ? "\t"
        : ["root", "list", "listItem", "blockquote", "table"].includes(
              node.type,
            )
          ? "\n\n"
          : "";
    return node.children.map(visit).join(separator);
  };
  return visit(parser.parse(text));
}
