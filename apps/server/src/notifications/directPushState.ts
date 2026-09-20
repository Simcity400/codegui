import type { DirectPushRegistration } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import type { ApplePushMessage } from "./applePush.ts";
import * as DateTime from "effect/DateTime";

export interface DirectPushThread {
  readonly state: AgentAwarenessState;
  readonly turnId: string | null;
}

const terminal = (phase: AgentAwarenessState["phase"]) =>
  phase === "completed" || phase === "failed";
const status = {
  starting: "Connecting",
  running: "Working",
  waiting_for_approval: "Approval",
  waiting_for_input: "Input",
  completed: "Done",
  failed: "Failed",
  stale: "Waiting",
} as const;

export function directPushAggregate(
  threads: Iterable<DirectPushThread>,
  now: number,
): RelayAgentActivityAggregateState | null {
  const states = [...threads].map((thread) => thread.state);
  const active = states.filter((state) => !terminal(state.phase));
  const recent = states.filter(
    (state) => terminal(state.phase) && now - Date.parse(state.updatedAt) < 15 * 60_000,
  );
  const rows = [...active, ...recent].sort(
    (a, b) =>
      Number(terminal(a.phase)) - Number(terminal(b.phase)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  if (rows.length === 0) return null;
  return {
    title: "T3 Code",
    subtitle: active.length ? "Agent work in progress" : "Agent work finished",
    activeCount: active.length,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    activities: rows.slice(0, 4).map((state) => ({
      environmentId: state.environmentId,
      threadId: state.threadId,
      threadTitle: state.threadTitle,
      projectTitle: state.projectTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: status[state.phase],
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    })),
  };
}

export function directPushAlert(
  previous: DirectPushThread | undefined,
  next: DirectPushThread | null,
) {
  if (!next) return null;
  const { state } = next;
  if (previous?.turnId === next.turnId && previous?.state.phase === state.phase) return null;
  const title =
    state.phase === "completed"
      ? "Agent finished"
      : state.phase === "failed"
        ? "Agent failed"
        : state.phase === "waiting_for_approval"
          ? "Approval needed"
          : state.phase === "waiting_for_input"
            ? "Input needed"
            : null;
  return title
    ? {
        aps: { alert: { title, body: state.threadTitle }, sound: "default" },
        environmentId: state.environmentId,
        threadId: state.threadId,
        deepLink: state.deepLink,
      }
    : null;
}

export function directActivityMessage(
  device: DirectPushRegistration,
  aggregate: RelayAgentActivityAggregateState | null,
  now: number,
): ApplePushMessage | null {
  if (!device.activityPushToken) return null;
  const timestamp = Math.floor(now / 1000);
  const ending = !device.liveActivitiesEnabled || aggregate === null || aggregate.activeCount === 0;
  return {
    token: device.activityPushToken,
    environment: device.apsEnvironment,
    kind: "liveactivity",
    payload: {
      aps: {
        timestamp,
        event: ending ? "end" : "update",
        "content-state": {
          name: "AgentActivity",
          props: JSON.stringify(
            aggregate ?? {
              title: "T3 Code",
              subtitle: "No active agents",
              activeCount: 0,
              activities: [],
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            },
          ),
        },
        ...(ending
          ? { "dismissal-date": timestamp + (aggregate && device.liveActivitiesEnabled ? 900 : 0) }
          : { "stale-date": timestamp + 600 }),
      },
    },
  };
}
