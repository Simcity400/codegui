import type { LegendListRef } from "@legendapp/list/react";
import {
  deriveAgentTranscriptTurn,
  selectAgentTranscript,
} from "@t3tools/client-runtime/state/agent-transcripts";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState, type ComponentProps } from "react";
import * as Option from "effect/Option";
import { threadHasOlderTurns } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEnvironmentThread } from "../../state/threads";

import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import { Button } from "../ui/button";
import { MessagesTimeline } from "./MessagesTimeline";

const NOOP = () => {};
const EMPTY_DIFFS: ComponentProps<typeof MessagesTimeline>["turnDiffSummaries"] = [];

type AgentTranscriptProps = Pick<
  ComponentProps<typeof MessagesTimeline>,
  // The roster model resolves spawn CTA rows inside this transcript too: a
  // subagent's own spawns otherwise read "Status unavailable".
  | "agentPanelModel"
  | "onOpenAgents"
  | "routeThreadKey"
  | "activeThreadEnvironmentId"
  | "markdownCwd"
  | "resolvedTheme"
  | "timestampFormat"
  | "workspaceRoot"
  | "onImageExpand"
  | "onFileOpen"
  | "onFileDownload"
  | "onUseArtifactTemplate"
  | "skills"
> & {
  agent: RuntimeSubagent;
  messages: readonly OrchestrationMessage[];
  activities: readonly OrchestrationThreadActivity[];
  /** The Agents panel is still fetching older pages; hide "no messages" until done. */
  historyPending?: boolean;
};

/** Reuse the main transcript's virtualized text, reasoning and tool renderers. */
export function AgentTranscript({
  agent,
  messages,
  activities,
  historyPending = false,
  ...props
}: AgentTranscriptProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const scoped = useMemo(
    () => selectAgentTranscript(messages, activities, agent.id),
    [messages, activities, agent.id],
  );
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(scoped.messages, [], deriveWorkLogEntries(scoped.activities)),
    [scoped],
  );
  const turn = useMemo(() => deriveAgentTranscriptTurn(scoped, agent), [scoped, agent]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MessagesTimeline
        {...props}
        listRef={listRef}
        timelineEntries={timelineEntries}
        {...turn}
        turnDiffSummaries={EMPTY_DIFFS}
        supportsConversationRollback={false}
        onOpenTurnDiff={NOOP}
        onRevertToTurnCount={NOOP}
        isRevertingCheckpoint={false}
        anchorMessageId={null}
        onAnchorReady={NOOP}
        contentInsetEndAdjustment={0}
        liveFollowEnabled={liveFollowEnabled}
        onIsAtEndChange={setLiveFollowEnabled}
        onManualNavigation={() => setLiveFollowEnabled(false)}
        hideEmptyPlaceholder={historyPending}
      />
      {!liveFollowEnabled && (
        <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
          <Button
            aria-label="Scroll to end"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setLiveFollowEnabled(true);
              void listRef.current?.scrollToEnd({ animated: true });
            }}
            className="pointer-events-auto gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
            size="xs"
            variant="glass"
          >
            <ChevronDownIcon className="size-3.5" />
            Scroll to end
          </Button>
        </div>
      )}
    </div>
  );
}

const EMPTY_MESSAGES: readonly OrchestrationMessage[] = [];
const EMPTY_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

type ScopedAgentTranscriptProps = Omit<
  AgentTranscriptProps,
  "messages" | "activities" | "historyPending"
> & {
  environmentId: EnvironmentId;
  threadId: ThreadId;
};

/**
 * Renders the agent's transcript from the thread's loaded rows. Subagent
 * messages and tool calls stream on the root thread, so reading them there
 * avoids a second subscription per transcript.
 */
export function ScopedAgentTranscript({
  environmentId,
  threadId,
  agent,
  ...props
}: ScopedAgentTranscriptProps) {
  const state = useEnvironmentThread(environmentId, threadId);
  const thread = Option.getOrNull(state.data);
  return (
    <AgentTranscript
      agent={agent}
      messages={thread?.messages ?? EMPTY_MESSAGES}
      activities={thread?.activities ?? EMPTY_ACTIVITIES}
      historyPending={threadHasOlderTurns(state)}
      {...props}
    />
  );
}
