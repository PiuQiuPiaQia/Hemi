import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Overlay scrolling keeps page geometry identical with or without overflow. */
export function WorkflowPage({
  children,
  className = "",
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <ScrollArea className="h59-page-shell" data-testid={testId}>
      <section className={`h59-studio ${className}`}>{children}</section>
    </ScrollArea>
  );
}
