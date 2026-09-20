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

const { send, createSender } = vi.hoisted(() => ({
  send: vi.fn<(message: ApplePushMessage) => Promise<ApplePushResult>>(),
  createSender: vi.fn(),
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
  }),
);

function run<A, E>(
  program: Effect.Effect<A, E, DirectPush>,
  configured = true,
  services = dependencies,
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

it.effect("delivers completion from an actual orchestration event and ends the phone's card", () =>
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
              Effect.as({ ok: true, status: 200, reason: null }),
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
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "liveactivity",
          payload: { aps: { event: "end" } },
        });
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "alert",
          payload: { aps: { alert: { title: "Agent finished" } }, threadId },
        });
      }),
      true,
      services,
    );
  }),
);
