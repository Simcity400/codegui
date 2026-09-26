import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type DirectPushRegistration,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig, layerTest } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { DirectPush, layer } from "./DirectPush.ts";
import {
  ApplePushConfiguration,
  type ApplePushMessage,
  type ApplePushResult,
} from "./applePush.ts";

const { send, createSender, activeSessions } = vi.hoisted(() => ({
  send: vi.fn<(message: ApplePushMessage) => Promise<ApplePushResult>>(),
  createSender: vi.fn(),
  activeSessions: new Set<string>(),
}));
vi.mock("./applePush.ts", async (original) => ({
  ...(await original<object>()),
  createApplePushSender: createSender,
}));
beforeEach(() => {
  send.mockReset();
  createSender.mockReset();
  createSender.mockReturnValue(send);
  send.mockResolvedValue({ ok: true, status: 200, reason: null });
  activeSessions.clear();
  activeSessions.add("session-1");
});

const principal: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("session-1"),
  subject: "owner",
  method: "bearer-access-token",
  scopes: new Set(),
};
const registration: DirectPushRegistration = {
  deviceId: "phone",
  bundleId: "com.example.app",
  apsEnvironment: "production",
  pushToken: "a".repeat(64),
  activityPushToken: null,
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
};

const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(ApplePushConfiguration));
const decodeCardStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ activities: Schema.Array(Schema.Struct({ status: Schema.String })) }),
  ),
);
const decodeCardProps = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ activities: Schema.Array(Schema.Struct({ threadId: Schema.String })) }),
  ),
);

const dependencies = Layer.mergeAll(
  Layer.mock(ServerEnvironment, { getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")) }),
  Layer.mock(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: "2026-09-20T00:00:00.000Z",
      }),
  }),
  Layer.mock(OrchestrationEngineService, { subscribeDomainEvents: Effect.succeed(Stream.never) }),
  Layer.mock(SessionStore, {
    cookieName: "test",
    legacyCookieName: undefined,
    streamChanges: Stream.never,
    // Revoked and expired sessions are simply absent from the active list.
    listActive: () =>
      Effect.sync(() =>
        [...activeSessions].map((sessionId) => ({
          sessionId: AuthSessionId.make(sessionId),
          subject: "owner",
          scopes: [],
          method: "bearer-access-token" as const,
          client: { deviceType: "mobile" as const },
          issuedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(0),
          lastConnectedAt: null,
          connected: false,
          current: false,
        })),
      ),
  }),
);
const encodeStoredDevices = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeStoredDevices = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        sessionId: Schema.String,
        registration: Schema.Struct({ deviceId: Schema.String }),
      }),
    ),
  ),
);
const storedDevices = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const devices = yield* decodeStoredDevices(
    yield* fs.readFileString(path.join(config.stateDir, "mobile-push.json")),
  );
  return devices.map((device) => device.registration.deviceId);
});

function run<A, E>(
  program: Effect.Effect<A, E, DirectPush | ServerConfig | FileSystem.FileSystem | Path.Path>,
  configured = true,
  services = dependencies,
  stored: ReadonlyArray<object> = [],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (configured) {
        const json = yield* encodeConfiguration({
          bundleId: "com.example.app",
          keyId: "KEY",
          teamId: "TEAM",
          privateKey: "test-only",
        });
        yield* fs.writeFileString(path.join(config.baseDir, "apple-push.json"), json);
      }
      if (stored.length > 0) {
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(config.stateDir, "mobile-push.json"),
          yield* encodeStoredDevices(stored),
        );
      }
      return yield* program.pipe(Effect.provide(layer.pipe(Layer.provide(services))));
    }),
  ).pipe(
    Effect.provide(
      layerTest(process.cwd(), { prefix: "direct-push-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

it.effect("reports missing configuration without accepting a device", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Effect.flatMap(DirectPush, (push) => push.register(principal, registration)),
      false,
    );
    expect(result.configured).toBe(false);
    expect(send).not.toHaveBeenCalled();
  }),
);
it.effect("keeps the server available when its Apple private key is invalid", () =>
  Effect.gen(function* () {
    createSender.mockImplementation(() => {
      throw new Error("Invalid private key");
    });
    const result = yield* run(
      Effect.flatMap(DirectPush, (push) => push.register(principal, registration)),
    );
    expect(result.configured).toBe(false);
    expect(send).not.toHaveBeenCalled();
  }),
);
it.effect("verifies a new notification token with Apple once and registers silently", () =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        expect(yield* push.register(principal, registration)).toMatchObject({
          configured: true,
          deliveryError: null,
        });
        yield* push.register(principal, registration);
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "background", payload: { aps: { "content-available": 1 } } }),
    );
  }),
);
it.effect("surfaces an Apple rejection and retries when the device re-registers", () =>
  Effect.gen(function* () {
    send.mockResolvedValueOnce({ ok: false, status: 400, reason: "BadDeviceToken" });
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        expect((yield* push.register(principal, registration)).deliveryError).toContain(
          "BadDeviceToken",
        );
        expect((yield* push.register(principal, registration)).deliveryError).toBeNull();
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
  }),
);
it.effect("registers from tracked activity without re-reading the shell snapshot", () =>
  Effect.gen(function* () {
    let snapshotReads = 0;
    const services = Layer.mergeAll(
      dependencies,
      Layer.mock(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.sync(() => {
            snapshotReads++;
            return {
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "2026-09-20T00:00:00.000Z",
            };
          }),
      }),
    );
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        yield* push.register(principal, registration);
        yield* push.register(principal, registration);
      }),
      true,
      services,
    );
    // Only the startup seed reads the snapshot.
    expect(snapshotReads).toBe(1);
  }),
);
it.effect("refuses a different app's bundle and does not use the configured key for it", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Effect.flatMap(DirectPush, (push) =>
        push.register(principal, { ...registration, bundleId: "com.other.app" }),
      ),
    );
    expect(result.configured).toBe(false);
    expect(send).not.toHaveBeenCalled();
  }),
);

it.effect("delivers completion from an actual orchestration event and later ends the card", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const now = DateTime.formatIso(yield* DateTime.now);
    const project: OrchestrationProjectShell = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    const threadId = ThreadId.make("thread-1");
    let thread: OrchestrationThreadShell = {
      id: threadId,
      projectId: project.id,
      title: "Task",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: {
        threadId,
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: now,
      },
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const services = Layer.mergeAll(
      dependencies,
      Layer.mock(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.sync(() => ({
            snapshotSequence: 0,
            projects: [project],
            threads: [thread],
            updatedAt: now,
          })),
        getThreadShellById: () => Effect.sync(() => Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(OrchestrationEngineService, {
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
    );
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        yield* push.register(principal, { ...registration, activityPushToken: "b".repeat(64) });
        send.mockImplementation((message) =>
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Mock the Promise-based APNs transport boundary.
          Effect.runPromise(
            Queue.offer(delivered, message).pipe(
              Effect.as(
                message.kind === "alert"
                  ? { ok: false, status: 503, reason: "ServiceUnavailable" }
                  : { ok: true, status: 200, reason: null },
              ),
            ),
          ),
        );
        thread = {
          ...thread,
          latestTurn: { ...thread.latestTurn!, state: "completed", completedAt: now },
          session: { ...thread.session!, status: "ready", activeTurnId: null },
        };
        yield* Queue.offer(events, {
          type: "thread.session-set",
          sequence: 1,
          eventId: EventId.make("evt-complete"),
          commandId: CommandId.make("cmd-complete"),
          aggregateKind: "thread",
          aggregateId: threadId,
          causationEventId: null,
          correlationId: null,
          payload: { threadId, session: thread.session! },
          occurredAt: now,
          metadata: {},
        });
        // The card stays updatable so a follow-up turn can reuse it.
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "liveactivity",
          payload: { aps: { event: "update" } },
        });
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "alert",
          payload: { aps: { alert: { title: "Agent finished" } }, threadId },
        });
        yield* TestClock.adjust("16 minutes");
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "liveactivity",
          payload: { aps: { event: "end" } },
        });
        send.mockResolvedValue({ ok: true, status: 200, reason: null });
        expect((yield* push.register(principal, registration)).deliveryError).toBeNull();
        expect(send.mock.calls.filter(([message]) => message.kind === "background")).toHaveLength(
          2,
        );
      }),
      true,
      services,
    );
  }),
);

it.effect("settling a long-finished thread does not put it back on the card", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
    const now = iso(nowMs);
    const finishedAt = iso(nowMs - 20 * 60_000);
    const project: OrchestrationProjectShell = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    const shell = (id: string, state: "running" | "completed", updatedAt: string) => {
      const threadId = ThreadId.make(id);
      return {
        id: threadId,
        projectId: project.id,
        title: id,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: {
          turnId: TurnId.make(`${id}-turn`),
          state,
          requestedAt: finishedAt,
          startedAt: finishedAt,
          completedAt: state === "completed" ? finishedAt : null,
          assistantMessageId: null,
        },
        createdAt: finishedAt,
        updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: finishedAt,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      } satisfies OrchestrationThreadShell;
    };
    const shells = new Map<string, OrchestrationThreadShell>([
      ["finished", shell("finished", "completed", finishedAt)],
      ["working", shell("working", "running", now)],
    ]);
    const event = (id: string): OrchestrationEvent => ({
      type: "thread.settled",
      sequence: 1,
      eventId: EventId.make(`evt-${id}`),
      commandId: CommandId.make(`cmd-${id}`),
      aggregateKind: "thread",
      aggregateId: ThreadId.make(id),
      causationEventId: null,
      correlationId: null,
      payload: { threadId: ThreadId.make(id), settledAt: now, updatedAt: now },
      occurredAt: now,
      metadata: {},
    });
    const services = Layer.mergeAll(
      dependencies,
      Layer.mock(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.sync(() => ({
            snapshotSequence: 0,
            projects: [project],
            threads: [...shells.values()],
            updatedAt: now,
          })),
        getThreadShellById: (threadId) =>
          Effect.sync(() => Option.fromNullishOr(shells.get(threadId))),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(OrchestrationEngineService, {
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
    );
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        yield* push.register(principal, { ...registration, activityPushToken: "b".repeat(64) });
        send.mockImplementation((message) =>
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Mock the Promise-based APNs transport boundary.
          Effect.runPromise(
            Queue.offer(delivered, message).pipe(
              Effect.as({ ok: true, status: 200, reason: null }),
            ),
          ),
        );
        // Settling only bumps updatedAt; the working thread then finishes.
        shells.set("finished", { ...shells.get("finished")!, updatedAt: now });
        yield* Queue.offer(events, event("finished"));
        shells.set("working", shell("working", "completed", now));
        yield* Queue.offer(events, event("working"));
        const card = yield* Queue.take(delivered);
        expect(card).toMatchObject({ kind: "liveactivity" });
        const props = yield* decodeCardProps(
          (card.payload as { aps: { "content-state": { props: string } } }).aps["content-state"]
            .props,
        );
        expect(props.activities.map((row) => row.threadId)).toEqual(["working"]);
      }),
      true,
      services,
    );
  }),
);

it.effect("a finished background task moves a Monitoring thread to Done", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const now = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make("thread-1");
    const project: OrchestrationProjectShell = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    let thread: OrchestrationThreadShell = {
      id: threadId,
      projectId: project.id,
      title: "Task",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      backgroundLiveness: "working",
    };
    const services = Layer.mergeAll(
      dependencies,
      Layer.mock(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.sync(() => ({
            snapshotSequence: 0,
            projects: [project],
            threads: [thread],
            updatedAt: now,
          })),
        getThreadShellById: () => Effect.sync(() => Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(OrchestrationEngineService, {
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
    );
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        const registered = yield* push.register(principal, {
          ...registration,
          activityPushToken: "b".repeat(64),
        });
        expect(registered.aggregate?.activities[0]?.status).toBe("Monitoring");
        send.mockImplementation((message) =>
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Mock the Promise-based APNs transport boundary.
          Effect.runPromise(
            Queue.offer(delivered, message).pipe(
              Effect.as({ ok: true, status: 200, reason: null }),
            ),
          ),
        );
        thread = { ...thread, backgroundLiveness: null };
        yield* Queue.offer(events, {
          type: "thread.activity-appended",
          sequence: 1,
          eventId: EventId.make("evt-task"),
          commandId: CommandId.make("cmd-task"),
          aggregateKind: "thread",
          aggregateId: threadId,
          causationEventId: null,
          correlationId: null,
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-task"),
              tone: "info",
              kind: "task.completed",
              summary: "Task completed",
              payload: { taskId: "task-1" },
              turnId: null,
              createdAt: now,
            },
          },
          occurredAt: now,
          metadata: {},
        });
        const card = yield* Queue.take(delivered);
        expect(card).toMatchObject({ kind: "liveactivity" });
        const props = yield* decodeCardStatus(
          (card.payload as { aps: { "content-state": { props: string } } }).aps["content-state"]
            .props,
        );
        expect(props.activities.map((row) => row.status)).toEqual(["Done"]);
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "alert",
          payload: { aps: { alert: { title: "Agent finished" } } },
        });
      }),
      true,
      services,
    );
  }),
);

it.effect("stops pushing to a device whose session was revoked or expired elsewhere", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const now = DateTime.formatIso(yield* DateTime.now);
    const project: OrchestrationProjectShell = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    const threadId = ThreadId.make("thread-1");
    const turn = {
      turnId: TurnId.make("turn-1"),
      requestedAt: now,
      startedAt: now,
      assistantMessageId: null,
    };
    let thread: OrchestrationThreadShell = {
      id: threadId,
      projectId: project.id,
      title: "Task",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: { ...turn, state: "running", completedAt: null },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const services = Layer.mergeAll(
      dependencies,
      Layer.mock(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.sync(() => ({
            snapshotSequence: 0,
            projects: [project],
            threads: [thread],
            updatedAt: now,
          })),
        getThreadShellById: () => Effect.sync(() => Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(OrchestrationEngineService, {
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
    );
    const tablet = { ...principal, sessionId: AuthSessionId.make("session-2") };
    const tabletRegistration = { ...registration, deviceId: "tablet", pushToken: "c".repeat(64) };
    activeSessions.add("session-2");
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        // The revoked phone registers first, so it would be pushed to first.
        yield* push.register(principal, registration);
        yield* push.register(tablet, tabletRegistration);
        // `t3 auth session revoke` and expiry never reach this server as events.
        activeSessions.delete("session-1");
        send.mockImplementation((message) =>
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Mock the Promise-based APNs transport boundary.
          Effect.runPromise(
            Queue.offer(delivered, message).pipe(
              Effect.as({ ok: true, status: 200, reason: null }),
            ),
          ),
        );
        thread = { ...thread, latestTurn: { ...turn, state: "completed", completedAt: now } };
        yield* Queue.offer(events, {
          type: "thread.settled",
          sequence: 1,
          eventId: EventId.make("evt-complete"),
          commandId: CommandId.make("cmd-complete"),
          aggregateKind: "thread",
          aggregateId: threadId,
          causationEventId: null,
          correlationId: null,
          payload: { threadId, settledAt: now, updatedAt: now },
          occurredAt: now,
          metadata: {},
        });
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "alert",
          token: tabletRegistration.pushToken,
        });
        yield* push.register(tablet, tabletRegistration);
        expect(yield* storedDevices).toEqual(["tablet"]);
      }),
      true,
      services,
    );
  }),
);

it.effect("drops stored devices whose session ended while the server was down", () =>
  Effect.gen(function* () {
    const devices = yield* run(storedDevices, true, dependencies, [
      { subject: "owner", sessionId: "session-1", registration },
      {
        subject: "owner",
        sessionId: "session-revoked",
        registration: { ...registration, deviceId: "old-phone", pushToken: "d".repeat(64) },
      },
    ]);
    expect(devices).toEqual(["phone"]);
  }),
);

it.effect("keeps only the most recently registered devices per owner", () =>
  Effect.gen(function* () {
    const devices = yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        for (const n of [1, 2, 3, 4, 5, 6])
          yield* push.register(principal, {
            ...registration,
            deviceId: `phone-${n}`,
            pushToken: String(n).repeat(64),
          });
        // Re-registering refreshes a device, so the next oldest goes instead.
        yield* push.register(principal, {
          ...registration,
          deviceId: "phone-2",
          pushToken: "2".repeat(64),
        });
        yield* push.register(principal, {
          ...registration,
          deviceId: "phone-7",
          pushToken: "7".repeat(64),
        });
        return yield* storedDevices;
      }),
    );
    expect(devices).toEqual(["phone-4", "phone-5", "phone-6", "phone-2", "phone-7"]);
  }),
);

it.effect("forgets a device once Apple rejects its only token", () =>
  Effect.gen(function* () {
    send.mockResolvedValueOnce({ ok: false, status: 400, reason: "BadDeviceToken" });
    const devices = yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        expect((yield* push.register(principal, registration)).deliveryError).toContain(
          "BadDeviceToken",
        );
        return yield* storedDevices;
      }),
    );
    expect(devices).toEqual([]);
  }),
);
