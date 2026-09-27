import {
  ORCHESTRATION_WS_METHODS,
  type AgentRoster,
  type AgentTranscriptSnapshot,
  type AgentTranscriptStreamItem,
  type OrchestrationMessage,
  type ThreadId,
} from "@t3tools/contracts";
import { applyAgentRosterUpdate } from "@t3tools/shared/agentTranscripts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribeDynamic, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const EMPTY_ROSTER: AgentRoster = { agents: [], backgroundTasks: [] };
const EMPTY_TRANSCRIPT: AgentTranscriptSnapshot = { messages: [], activities: [] };

type AgentStreamMethod =
  | typeof ORCHESTRATION_WS_METHODS.subscribeAgentRoster
  | typeof ORCHESTRATION_WS_METHODS.subscribeAgentTranscript;

// UI configuration can be cached across a host downgrade. Gate the wire request
// on the actual session too; the UI switches to its legacy path when config arrives.
export function subscribeAgentStream<T extends AgentStreamMethod>(
  tag: T,
  input: EnvironmentRpcInput<T>,
) {
  return subscribeDynamic(tag, (session) =>
    session.initialConfig.pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((config) =>
        config?.separateAgentTranscripts === true ? Effect.succeed(input) : Effect.never,
      ),
    ),
  );
}

/** Snapshot replacement on each connection prevents replaying deltas onto stale text. */
export function applyAgentTranscriptItem(
  current: AgentTranscriptSnapshot,
  item: AgentTranscriptStreamItem,
): AgentTranscriptSnapshot {
  if (item.kind === "snapshot") return item.snapshot;
  const event = item.event;
  if (event.type === "thread.message-sent") {
    const { messageId: id, threadId: _threadId, ...payload } = event.payload;
    const message: OrchestrationMessage = { ...payload, id };
    let found = false;
    const messages = current.messages.map((entry) => {
      if (entry.id !== id) return entry;
      found = true;
      return {
        ...entry,
        ...message,
        createdAt: entry.createdAt,
        updatedAt: message.streaming ? entry.updatedAt : message.updatedAt,
        text: message.streaming ? entry.text + message.text : message.text || entry.text,
      };
    });
    if (!found) messages.push(message);
    return { ...current, messages };
  }
  if (event.type === "thread.activity-appended") {
    const activity = { ...event.payload.activity, sequence: event.sequence };
    const activities = current.activities.filter((entry) => entry.id !== activity.id);
    // This stream delivers strictly increasing sequences after its ordered snapshot.
    activities.push(activity);
    return { ...current, activities };
  }
  return current;
}

/** Fork subscriptions are shared by consumers and released as soon as the surface closes. */
export function createAgentObservabilityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    roster: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:agent-roster",
      idleTtlMs: 0,
      subscribe: (input: { readonly threadId: ThreadId }) =>
        subscribeAgentStream(ORCHESTRATION_WS_METHODS.subscribeAgentRoster, input).pipe(
          Stream.mapAccum(
            () => EMPTY_ROSTER,
            (current, item) => {
              const next =
                item.kind === "snapshot"
                  ? item.snapshot
                  : applyAgentRosterUpdate(current, item.update);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    transcript: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:agent-transcript",
      idleTtlMs: 0,
      subscribe: (input: { readonly threadId: ThreadId; readonly agentId: string }) =>
        subscribeAgentStream(ORCHESTRATION_WS_METHODS.subscribeAgentTranscript, input).pipe(
          Stream.chunks,
          Stream.mapAccum(
            () => EMPTY_TRANSCRIPT,
            (current, items) => {
              const next = items.reduce(applyAgentTranscriptItem, current);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
  };
}
