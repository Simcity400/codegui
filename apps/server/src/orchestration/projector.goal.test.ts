import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects the provider goal onto the thread without touching its recency", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.threads[0]?.goal ?? null).toBeNull();

    const goal = {
      objective: "Ship the release",
      status: "blocked" as const,
      tokenBudget: null,
      tokensUsed: 24_951_787,
      timeUsedSeconds: 28_458,
      createdAt: 1_788_588_115,
      updatedAt: 1_788_616_573,
      turnId: TurnId.make("turn-blocked"),
    };
    const set = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.goal-set",
        payload: { threadId: ThreadId.make("thread-1"), goal },
      }),
    );
    expect(set.threads[0]?.goal).toEqual(goal);
    expect(set.threads[0]?.updatedAt).toBe(now);

    const cleared = yield* projectEvent(
      set,
      makeEvent({
        sequence: 3,
        type: "thread.goal-set",
        payload: { threadId: ThreadId.make("thread-1"), goal: null },
      }),
    );
    expect(cleared.threads[0]?.goal).toBeNull();
  }),
);
