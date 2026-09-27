import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type AgentTranscriptSnapshot,
  type ServerConfig,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  agentRosterUpdate,
  applyAgentRosterUpdate,
  compactAgentCursors,
  parentThreadItem,
} from "@t3tools/shared/agentTranscripts";
import { applyAgentTranscriptItem, subscribeAgentStream } from "./agentObservability.ts";
import { foldThreadTasks } from "./subagentRuntime.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

const threadId = ThreadId.make("thread");
const at = "2026-09-27T00:00:00.000Z";
const envelope = (sequence: number) => ({
  sequence,
  eventId: EventId.make(`e-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
function message(sequence: number, text: string, streaming = true): OrchestrationEvent {
  return {
    ...envelope(sequence),
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make("message"),
      agentId: "agent",
      role: "assistant",
      text,
      streaming,
      turnId: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}
function activity(
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return {
    ...envelope(sequence),
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.make(`a-${sequence}`),
        tone: "info",
        kind,
        summary: kind,
        payload,
        turnId: null,
        createdAt: at,
      },
    },
  };
}

describe("fork agent subscriptions", () => {
  it.effect(
    "checks the live session before sending fork RPCs, even with stale client configuration",
    () =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        let calls = 0;
        const client = {
          [ORCHESTRATION_WS_METHODS.subscribeAgentRoster]: () => {
            calls++;
            return Stream.make({
              kind: "snapshot" as const,
              snapshot: { agents: [], backgroundTasks: [] },
            });
          },
        } as unknown as WsRpcProtocolClient;
        const legacy: RpcSession = {
          client,
          initialConfig: Deferred.succeed(checked, undefined).pipe(Effect.as({} as ServerConfig)),
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const session = yield* SubscriptionRef.make(Option.some(legacy));
        const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
          AVAILABLE_CONNECTION_STATE,
        );
        const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.none(),
        );
        const fiber = yield* subscribeAgentStream(ORCHESTRATION_WS_METHODS.subscribeAgentRoster, {
          threadId,
        }).pipe(
          Stream.runHead,
          Effect.provide(
            Layer.mock(EnvironmentSupervisor, {
              session,
              state,
              prepared,
              target: new PrimaryConnectionTarget({
                environmentId: EnvironmentId.make("environment"),
                label: "Test",
                httpBaseUrl: "http://test",
                wsBaseUrl: "ws://test",
              }),
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(checked);
        expect(calls).toBe(0);
        yield* SubscriptionRef.set(
          session,
          Option.some({
            ...legacy,
            initialConfig: Effect.succeed({ separateAgentTranscripts: true } as ServerConfig),
          }),
        );
        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual({
          kind: "snapshot",
          snapshot: { agents: [], backgroundTasks: [] },
        });
        expect(calls).toBe(1);
      }),
  );

  it("keeps task lifecycle and requests on the parent while reducing child content to watermarks", () => {
    expect(parentThreadItem(message(1, "large transcript"))).toEqual({
      kind: "cursor",
      sequence: 1,
    });
    expect(
      parentThreadItem(activity(2, "tool.updated", { agentId: "agent", output: "large output" })),
    ).toEqual({ kind: "cursor", sequence: 2 });
    for (const kind of [
      "task.started",
      "task.completed",
      "approval.requested",
      "user-input.requested",
      "tool.progress",
    ]) {
      const event = activity(3, kind, { agentId: "agent" });
      expect(parentThreadItem(event)).toEqual({ kind: "event", event });
    }
    const parent = activity(4, "tool.completed", {});
    expect(parentThreadItem(parent)).toEqual({ kind: "event", event: parent });
    expect(
      compactAgentCursors([
        parentThreadItem(message(1, "a")),
        parentThreadItem(message(2, "b")),
        parentThreadItem(parent),
        parentThreadItem(message(5, "c")),
      ]),
    ).toEqual([
      { kind: "cursor", sequence: 2 },
      { kind: "event", event: parent },
      { kind: "cursor", sequence: 5 },
    ]);
  });

  it("merges deltas and completion text, then replaces all content on reconnect or revert", () => {
    let state: AgentTranscriptSnapshot = { messages: [], activities: [] };
    for (const event of [message(1, "Hello"), message(2, " world"), message(3, "", false)]) {
      state = applyAgentTranscriptItem(state, { kind: "event", event });
    }
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      text: "Hello world",
      streaming: false,
      agentId: "agent",
    });
    state = applyAgentTranscriptItem(state, {
      kind: "event",
      event: message(4, "Canonical", false),
    });
    expect(state.messages[0]?.text).toBe("Canonical");
    const tool = activity(5, "tool.updated", { agentId: "agent" });
    state = applyAgentTranscriptItem(state, { kind: "event", event: tool });
    state = applyAgentTranscriptItem(state, { kind: "event", event: { ...tool, sequence: 6 } });
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]?.sequence).toBe(6);
    const authoritative = { messages: [], activities: [] };
    expect(applyAgentTranscriptItem(state, { kind: "snapshot", snapshot: authoritative })).toBe(
      authoritative,
    );
  });

  it("patches a bounded roster without losing identities or removals", () => {
    const a = activity(1, "task.started", { taskId: "a", title: "First", agentKind: "agent" })
      .payload.activity;
    const b = activity(2, "task.started", { taskId: "b", title: "Second", agentKind: "agent" })
      .payload.activity;
    const previous = foldThreadTasks([a, b]);
    const next = foldThreadTasks([
      a,
      b,
      activity(3, "task.completed", { taskId: "b", status: "completed" }).payload.activity,
    ]);
    const patch = agentRosterUpdate(previous, next);
    expect(patch.agents.map((agent) => agent.id)).toEqual(["b"]);
    const applied = applyAgentRosterUpdate(previous, patch);
    expect(applied).toEqual(next);
    expect(applied.agents[0]).toBe(previous.agents[0]);
    const empty = { agents: [], backgroundTasks: [] };
    expect(applyAgentRosterUpdate(applied, agentRosterUpdate(applied, empty))).toEqual(empty);
  });
});
