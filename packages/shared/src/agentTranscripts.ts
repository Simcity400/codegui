import type {
  AgentRoster,
  AgentRosterUpdate,
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import type { NonEmptyReadonlyArray } from "effect/Array";

export const AGENT_ROSTER_ACTIVITY_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "tool.progress",
  "session.reset",
  "runtime.error",
] as const;

export function agentActivityOwner(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  return Predicate.isObject(payload) &&
    typeof payload.agentId === "string" &&
    payload.agentId.trim()
    ? payload.agentId
    : undefined;
}

/** Only fork transcript content is isolated; task lifecycle and requests keep their upstream route. */
export function isAgentTranscriptActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    agentActivityOwner(activity) !== undefined &&
    (activity.kind === "tool.started" ||
      activity.kind === "tool.updated" ||
      activity.kind === "tool.completed")
  );
}

export function isAgentTranscriptEvent(event: OrchestrationEvent): boolean {
  return event.type === "thread.message-sent"
    ? typeof event.payload.agentId === "string" && event.payload.agentId.trim().length > 0
    : event.type === "thread.activity-appended" &&
        isAgentTranscriptActivity(event.payload.activity);
}

/** Keep the replay watermark without transferring content belonging to an unopened transcript. */
export function parentThreadItem(
  event: OrchestrationEvent,
): Extract<OrchestrationThreadStreamItem, { kind: "cursor" | "event" }> {
  return isAgentTranscriptEvent(event)
    ? { kind: "cursor", sequence: event.sequence }
    : { kind: "event", event };
}

/** Keep the last watermark in each child-only run without crossing parent event boundaries. */
export function compactAgentCursors<T extends OrchestrationThreadStreamItem>(
  items: NonEmptyReadonlyArray<T>,
): NonEmptyReadonlyArray<T> {
  const result: [T, ...T[]] = [items[0]];
  for (const item of items.slice(1)) {
    const previous = result.at(-1);
    if (item.kind === "cursor" && previous?.kind === "cursor") {
      if (item.sequence > previous.sequence) result[result.length - 1] = item;
    } else result.push(item);
  }
  return result;
}

export function agentRosterUpdate(previous: AgentRoster, next: AgentRoster): AgentRosterUpdate {
  const changed = (before: AgentRoster["agents"], after: AgentRoster["agents"]) => {
    const byId = new Map(before.map((agent) => [agent.id, agent]));
    return after.filter((agent) => JSON.stringify(byId.get(agent.id)) !== JSON.stringify(agent));
  };
  return {
    agents: changed(previous.agents, next.agents),
    backgroundTasks: changed(previous.backgroundTasks, next.backgroundTasks),
    agentIds: next.agents.map((agent) => agent.id),
    backgroundTaskIds: next.backgroundTasks.map((agent) => agent.id),
  };
}

export function applyAgentRosterUpdate(
  previous: AgentRoster,
  update: AgentRosterUpdate,
): AgentRoster {
  const merge = (
    before: AgentRoster["agents"],
    changes: AgentRoster["agents"],
    ids: readonly string[],
  ) => {
    const byId = new Map(before.map((agent) => [agent.id, agent]));
    for (const agent of changes) byId.set(agent.id, agent);
    return ids.flatMap((id) => {
      const agent = byId.get(id);
      return agent ? [agent] : [];
    });
  };
  return {
    agents: merge(previous.agents, update.agents, update.agentIds),
    backgroundTasks: merge(
      previous.backgroundTasks,
      update.backgroundTasks,
      update.backgroundTaskIds,
    ),
  };
}
