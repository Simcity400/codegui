import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { isAgentMessage } from "@t3tools/client-runtime/state/agent-transcripts";
import { isSubagentSessionLive } from "@t3tools/client-runtime/state/subagentPresentation";
import {
  deriveAgentPanelModel,
  foldThreadTasks,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ServerProvider,
} from "@t3tools/contracts";
import { useMemo, type ComponentProps } from "react";

import { ScopedAgentTranscript } from "./AgentTranscript";

// Fork subagent wiring for ChatView. It lives here so ChatView carries only
// small hooks, which keeps upstream syncs from conflicting in its hot spots.

const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];

/**
 * Agents surface model from the thread's task fold, background tasks
 * included. sessionLive derives interruption for tasks orphaned by
 * session death.
 */
export function useAgentPanelModel(
  session: Parameters<typeof isSubagentSessionLive>[0],
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const sessionLive = isSubagentSessionLive(session);
  return useMemo(
    () => deriveAgentPanelModel(foldThreadTasks(activities, { sessionLive })),
    [activities, sessionLive],
  );
}

/** Subagent messages belong to their agent's transcript, not the parent timeline. */
export function useParentMessages<Message extends Pick<OrchestrationMessage, "agentId">>(
  messages: ReadonlyArray<Message> | undefined,
) {
  return useMemo(() => messages?.filter((message) => !isAgentMessage(message)), [messages]);
}

type ChatAgentTranscriptProps = Omit<
  ComponentProps<typeof ScopedAgentTranscript>,
  "environmentId" | "threadId" | "activeThreadEnvironmentId" | "markdownCwd" | "skills"
> & {
  threadRef: ScopedThreadRef;
  cwd: string | null;
  providerStatus: ServerProvider | null;
};

/** Agents panel transcript scoped to ChatView's active thread. */
export function ChatAgentTranscript({
  threadRef,
  cwd,
  providerStatus,
  ...props
}: ChatAgentTranscriptProps) {
  return (
    <ScopedAgentTranscript
      {...props}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      activeThreadEnvironmentId={threadRef.environmentId}
      markdownCwd={cwd ?? undefined}
      skills={
        providerStatus ? resolveProviderSkillsForCwd(providerStatus, cwd) : EMPTY_PROVIDER_SKILLS
      }
    />
  );
}
