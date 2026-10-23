import type { RunActivityView } from "@shared/protocol";
import {
  ConversationFlowProvider,
  RunActivity as SDKRunActivity,
} from "@hemi/conversation-flow/parts";
import { useDesktopFlowAppearance } from "./conversation-flow";
import { useAppearance } from "@/appearance/use-appearance";

/** Keep the run summary beside the desktop composer, using the SDK's actual implementation. */
export function RunActivity({
  activity,
  active = true,
}: {
  activity?: RunActivityView | null;
  active?: boolean;
}) {
  const { tokens, container } = useDesktopFlowAppearance();
  const { activity: visibility } = useAppearance();
  return (
    <div ref={container} className="contents">
      <ConversationFlowProvider
        part
        scope={{
          environmentId: "desktop",
          conversationId: "run-summary",
          generation: "1",
        }}
        appearance={{ tokens }}
        active={active && visibility.visible}
      >
        <SDKRunActivity activity={activity} />
      </ConversationFlowProvider>
    </div>
  );
}
