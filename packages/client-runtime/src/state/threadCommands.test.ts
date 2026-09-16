import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
  type CodexGoal,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadGoal,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  codexGoalSessionActivity,
  codexGoalStatusAction,
  createThreadEnvironmentAtoms,
  findCodexGoalReportMessage,
  formatCodexGoalDescription,
  formatCodexGoalDuration,
  formatCodexGoalError,
  formatCodexGoalStatus,
  formatCodexGoalUsage,
  formatCodexGoalUsageCompact,
  parseCodexGoalCommand,
  toCodexGoalSetInput,
} from "./threadCommands.ts";

const threadId = ThreadId.make("thread-1");
const goal = (objective: string, status: CodexGoal["status"] = "active"): CodexGoal => ({
  objective,
  status,
  tokenBudget: 100_000,
  tokensUsed: 12_000,
  timeUsedSeconds: 90,
  createdAt: 1_777_000_000,
  updatedAt: 1_777_000_090,
});

describe("parseCodexGoalCommand", () => {
  it("maps all supported Goal commands to native mutations", () => {
    const cases = [
      ["/goal", { action: "edit" }],
      ["/goal edit", { action: "edit" }],
      ["/goal status", { action: "status" }],
      ["/goal create Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal steer Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal edit Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal pause", { action: "set", status: "paused" }],
      ["/goal resume", { action: "set", status: "active" }],
      ["/goal clear", { action: "clear" }],
      ["/goal reset", { action: "clear" }],
      ["please create a goal", null],
    ] as const;
    for (const [command, expected] of cases) {
      expect(parseCodexGoalCommand(command)).toEqual(expected);
    }
  });

  it("rejects arguments the native commands do not take", () => {
    for (const command of ["/goal pause now", "/goal clear it", "/goal create", "/goal steer"]) {
      expect(parseCodexGoalCommand(command)?.action).toBe("invalid");
    }
  });
});

describe("toCodexGoalSetInput", () => {
  it("adds the thread id without inventing omitted native fields", () => {
    expect(toCodexGoalSetInput(threadId, { action: "set", objective: "Ship it" })).toEqual({
      threadId,
      objective: "Ship it",
    });
  });
});

describe("goal formatting", () => {
  it("formats native usage consistently for clients", () => {
    expect(formatCodexGoalUsage(goal("Ship it"))).toBe("12,000 / 100,000 tokens · 1m");
    expect(formatCodexGoalUsage({ ...goal("Ship it"), tokenBudget: null })).toBe(
      "12,000 tokens · 1m",
    );
    expect(formatCodexGoalDescription(goal("Ship it"))).toBe(
      "Ship it - 12,000 / 100,000 tokens · 1m",
    );
  });

  it("compacts usage for the one-line goal row", () => {
    expect(formatCodexGoalUsageCompact(goal("Ship it"))).toBe("12k / 100k tokens · 1m");
    expect(formatCodexGoalUsageCompact({ ...goal("Ship it"), tokenBudget: null })).toBe(
      "12k tokens · 1m",
    );
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 950, tokenBudget: 2_500 }),
    ).toBe("950 / 2.5k tokens · 1m");
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 1_250_000, tokenBudget: null }),
    ).toBe("1.3M tokens · 1m");
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 9_960, tokenBudget: 999_600 }),
    ).toBe("10k / 1M tokens · 1m");
  });

  it("formats elapsed time at the coarsest useful unit", () => {
    expect(formatCodexGoalDuration(28_458)).toBe("7h 54m");
    expect(formatCodexGoalDuration(125)).toBe("2m");
    expect(formatCodexGoalDuration(45)).toBe("45s");
  });

  it("uses Codex's own status wording", () => {
    const statuses = [
      "active",
      "paused",
      "budgetLimited",
      "usageLimited",
      "complete",
      "blocked",
    ] as const;
    expect(statuses.map(formatCodexGoalStatus)).toEqual([
      "active",
      "paused",
      "budget limited",
      "usage limited",
      "complete",
      "stalled",
    ]);
  });
});

describe("goal status controls", () => {
  it("derives session activity from the provider session", () => {
    expect(codexGoalSessionActivity(null)).toBe("stopped");
    expect(codexGoalSessionActivity({ status: "stopped" } as never)).toBe("stopped");
    expect(codexGoalSessionActivity({ status: "running" } as never)).toBe("running");
    expect(codexGoalSessionActivity({ status: "starting" } as never)).toBe("running");
    expect(codexGoalSessionActivity({ status: "ready" } as never)).toBe("idle");
  });

  it("offers pause while active, continue once the thread stopped, resume when halted", () => {
    expect(codexGoalStatusAction(goal("x"), "running")).toBe("pause");
    expect(codexGoalStatusAction(goal("x"), "idle")).toBe("pause");
    expect(codexGoalStatusAction(goal("x"), "stopped")).toBe("continue");
    for (const status of ["paused", "blocked", "usageLimited", "budgetLimited"] as const) {
      expect(codexGoalStatusAction(goal("x", status), "stopped")).toBe("resume");
    }
    expect(codexGoalStatusAction(goal("x", "complete"), "stopped")).toBeNull();
  });
});

describe("findCodexGoalReportMessage", () => {
  const message = (
    id: string,
    role: OrchestrationMessage["role"],
    turnId: string | null,
    text = "text",
    agentId?: string,
  ): OrchestrationMessage => ({
    id: MessageId.make(id),
    role,
    text,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(agentId === undefined ? {} : { agentId }),
  });
  const blockedGoal: OrchestrationThreadGoal = {
    ...goal("x", "blocked"),
    turnId: TurnId.make("turn-2"),
  };

  it("returns the root assistant message that ended the reporting turn", () => {
    const messages = [
      message("m1", "assistant", "turn-1", "earlier"),
      message("m2", "user", "turn-2", "go"),
      message("m3", "assistant", "turn-2", "progress"),
      message("m4", "assistant", "turn-2", "child", "agent-1"),
      message("m5", "assistant", "turn-2", "Blocked on credentials"),
      message("m6", "assistant", "turn-2", "   "),
    ];
    expect(findCodexGoalReportMessage(messages, blockedGoal)?.id).toBe("m5");
  });

  it("returns nothing when the update was not tied to a turn", () => {
    expect(
      findCodexGoalReportMessage([message("m1", "assistant", "turn-2")], {
        ...blockedGoal,
        turnId: null,
      }),
    ).toBeNull();
  });
});

describe("formatCodexGoalError", () => {
  it("appends the provider reason carried in the error cause", () => {
    const error = new Error("Codex Goal set failed for thread thread-1", {
      cause: new Error("Provider 'claude' is not implemented"),
    });
    expect(formatCodexGoalError(error)).toBe(
      "Codex Goal set failed for thread thread-1: Provider 'claude' is not implemented",
    );
  });

  it("falls back to the wrapper message when the cause carries no reason", () => {
    expect(formatCodexGoalError(new Error("Codex Goal set failed for thread thread-1"))).toBe(
      "Codex Goal set failed for thread thread-1",
    );
  });

  it("handles non-error failures", () => {
    expect(formatCodexGoalError("boom")).toBe("Codex Goal operation failed.");
  });
});

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const NOW = "2026-09-12T10:00:00.000Z";
const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: NOW,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
};

const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* () {
  const requests = yield* Queue.unbounded<{
    command: ClientOrchestrationCommand;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<{ sequence: number }, Error>();
              yield* Queue.offer(requests, { command, reply });
              return yield* Deferred.await(reply);
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  return { registry, commands, snapshotAtom, visibleAtom, requests };
});

describe("remote thread lifecycle commands", () => {
  const actions = [
    ["settle", {}, { settledOverride: "settled", pinnedAt: null, snoozedUntil: null }],
    ["unsettle", { reason: "user" }, { settledOverride: "active", settledAt: null }],
    [
      "snooze",
      { snoozedUntil: "2099-01-01T00:00:00.000Z" },
      { snoozedUntil: "2099-01-01T00:00:00.000Z" },
    ],
    ["unsnooze", { reason: "user" }, { snoozedUntil: null, snoozedAt: null }],
    ["pin", { orderKey: "a" }, { pinnedAt: expect.any(String), pinOrderKey: "a" }],
    ["unpin", {}, { pinnedAt: null, pinOrderKey: null }],
    ["reorderPin", { orderKey: "b" }, { pinOrderKey: "b" }],
    ["reorderActive", { orderKey: "b" }, { activeOrderKey: "b" }],
  ] as const;

  for (const [action, input, expected] of actions) {
    it.effect(`shows ${action} before a delayed remote reply and rolls back a rejection`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const source = h.snapshotAtom(ENVIRONMENT_ID);
        const initial = {
          ...SNAPSHOT,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              ...(action === "unsettle" || action === "pin"
                ? { settledOverride: "settled" as const, settledAt: NOW }
                : {}),
              ...(action === "unsnooze" || action === "settle" || action === "pin"
                ? { snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: NOW }
                : {}),
              ...(action === "unpin" || action === "settle"
                ? { pinnedAt: NOW, pinOrderKey: "a" }
                : {}),
            },
          ],
        };
        h.registry.set(source, initial);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            commandId: CommandId.make(action),
            reason: "user",
            orderKey: "a",
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            ...input,
          },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(initial);
      }),
    );
  }

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed remotely" }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
        title: "Renamed remotely",
        settledOverride: "settled",
      });
      const confirmed = {
        ...changed,
        snapshotSequence: 3,
        threads: [
          {
            ...changed.threads[0]!,
            settledOverride: "settled" as const,
            settledAt: "2026-09-12T12:00:00.000Z",
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 4 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBeNull();
    }),
  );

  it.effect(
    "shows a queued reverse action immediately and preserves it if the earlier action fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const settle = h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const first = yield* Queue.take(h.requests);
        const unsettle = h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Effect.promise(() => settle);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.unsettle");
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "active" as const }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 2 });
        yield* Effect.promise(() => unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Effect.promise(() => result);
      expect(h.registry.get(h.visibleAtom)).toBe(removed);
    }),
  );

  it.effect("keeps pending approvals visible while a lifecycle request is pending", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const blocked = {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, hasPendingApprovals: true }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), blocked);
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(blocked.threads[0]);
      yield* Deferred.fail(request.reply, new Error("Approval pending"));
      yield* Effect.promise(() => result);
    }),
  );

  for (const action of ["settle", "snooze"] as const) {
    it.effect(`restores a confirmed ${action} when a queued undo fails`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parked =
          action === "settle"
            ? { settledOverride: "settled" as const }
            : { snoozedUntil: "2099-01-01T00:00:00.000Z" };
        const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const first = yield* Queue.take(h.requests);
        const undo = h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        yield* Deferred.succeed(first.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, ...parked }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe(
          action === "settle" ? "thread.unsettle" : "thread.unsnooze",
        );
        yield* Deferred.fail(second.reply, new Error("Undo rejected"));
        expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
    );

    it.effect(`preserves a newer approval when the ${action} reply arrives after the shell`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, hasPendingApprovals: true }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)).toBe(newer);
      }),
    );

    it.effect(`shows an accepted ${action} while the shell still has an old input request`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stale = {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, hasPendingUserInput: true }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), stale);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle"
            ? { settledOverride: "settled" }
            : { snoozedUntil: "2099-01-01T00:00:00.000Z" },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.hasPendingUserInput).toBe(false);
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
    );
  }
});
