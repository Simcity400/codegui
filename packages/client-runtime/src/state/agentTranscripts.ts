import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { isActiveSubagentStatus, type RuntimeSubagent } from "./subagentRuntime.ts";

/** Feed the ordinary turn renderer the selected agent's lifecycle, not its parent's. */
export function deriveAgentTranscriptTurn(
  transcript: ReturnType<typeof selectAgentTranscript>,
  agent: RuntimeSubagent | undefined,
) {
  let turnId: OrchestrationMessage["turnId"] = null;
  let latestAt = "";
  for (const entries of [transcript.messages, transcript.activities]) {
    for (const entry of entries) {
      if (entry.turnId !== null && entry.createdAt >= latestAt) {
        turnId = entry.turnId;
        latestAt = entry.createdAt;
      }
    }
  }
  const isWorking = agent !== undefined && isActiveSubagentStatus(agent.status);
  const state = isWorking
    ? ("running" as const)
    : agent?.status === "failed"
      ? ("error" as const)
      : agent?.status === "cancelled" || agent?.status === "interrupted"
        ? ("interrupted" as const)
        : ("completed" as const);
  return {
    isWorking,
    activeTurnStartedAt: isWorking ? (agent?.startedAt ?? null) : null,
    runningTurnId: isWorking ? turnId : null,
    latestTurn:
      turnId === null
        ? null
        : {
            turnId,
            state,
            startedAt: agent?.startedAt ?? null,
            completedAt: isWorking ? null : (agent?.completedAt ?? agent?.updatedAt ?? latestAt),
          },
  };
}

export function isAgentMessage(message: Pick<OrchestrationMessage, "agentId">): boolean {
  return typeof message.agentId === "string" && message.agentId.trim().length > 0;
}

/** Select stored agent content from the loaded history window for ordinary transcript renderers. */
export function selectAgentTranscript(
  messages: readonly OrchestrationMessage[],
  activities: readonly OrchestrationThreadActivity[],
  agentId: string,
): { messages: OrchestrationMessage[]; activities: OrchestrationThreadActivity[] } {
  if (!agentId.trim()) return { messages: [], activities: [] };
  return {
    messages: messages
      .filter((message) => message.agentId === agentId)
      .map(({ agentId: _agentId, ...message }) => message),
    activities: activities.flatMap((activity) => {
      if (!activity.payload || typeof activity.payload !== "object") return [];
      const payload = activity.payload as Record<string, unknown>;
      if (payload.agentId !== agentId) return [];
      // The main transcript never shows persisted reasoning (only the live
      // "Thinking" row), and agent transcripts must read the same way. Older
      // history may still carry reasoning rows, so they are dropped here too.
      if (payload.itemType === "reasoning") return [];
      // Root renderers hide attributed rows and provider-marked timeline bypasses.
      // Remove only those routing stamps from copies; retain tool payloads.
      const { agentId: _agentId, timelineBypass: _timelineBypass, ...scopedPayload } = payload;
      return [{ ...activity, payload: scopedPayload }];
    }),
  };
}
