import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  RunId,
  ProviderInstanceId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type Project,
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
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { DirectPush, layer } from "./DirectPush.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  ApplePushConfiguration,
  type ApplePushMessage,
  type ApplePushResult,
} from "./applePush.ts";

const { send, createSender, activeSessions, revokedSessions, cloudAccount } = vi.hoisted(() => ({
  send: vi.fn<(message: ApplePushMessage) => Promise<ApplePushResult>>(),
  createSender: vi.fn(),
  activeSessions: new Set<string>(),
  revokedSessions: new Set<string>(),
  cloudAccount: { id: "linked-user" as string | null },
}));
vi.mock("./applePush.ts", async (original) => ({
  ...(await original<object>()),
  createApplePushSender: createSender,
}));
vi.mock("../atomicWrite.ts", async (original) => {
  const module = await original<typeof import("../atomicWrite.ts")>();
  return { ...module, writeFileStringAtomically: vi.fn(module.writeFileStringAtomically) };
});
beforeEach(() => {
  vi.mocked(writeFileStringAtomically).mockClear();
  send.mockReset();
  createSender.mockReset();
  createSender.mockReturnValue(send);
  send.mockResolvedValue({ ok: true, status: 200, reason: null });
  activeSessions.clear();
  revokedSessions.clear();
  cloudAccount.id = "linked-user";
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

const cloudPrincipal = {
  ...principal,
  subject: "cloud-connect",
  method: "dpop-access-token" as const,
};

const dependencies = Layer.mergeAll(
  Layer.mock(ServerEnvironment, { getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")) }),
  Layer.mock(ThreadManagementService, {
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [],
        archivedThreads: [],
      }),
    streamDomainEvents: Stream.never,
  }),
  Layer.mock(ProjectService, {
    snapshot: Effect.succeed({ projects: [], updatedAt: "2026-10-07T00:00:00Z" }),
  }),
  Layer.mock(ServerSecretStore, {
    get: () =>
      Effect.sync(() =>
        cloudAccount.id === null
          ? Option.none()
          : Option.some(new TextEncoder().encode(cloudAccount.id)),
      ),
  }),
  Layer.mock(AuthSessionRepository, {
    getById: ({ sessionId }) =>
      Effect.sync(() =>
        Option.some({
          sessionId,
          subject: "cloud-connect",
          method: "dpop-access-token" as const,
          scopes: [],
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "mobile" as const,
            os: null,
            browser: null,
          },
          issuedAt: DateTime.toUtc(DateTime.makeUnsafe(0)),
          expiresAt: DateTime.toUtc(DateTime.makeUnsafe(0)),
          revokedAt: revokedSessions.has(sessionId) ? DateTime.toUtc(DateTime.makeUnsafe(1)) : null,
          lastConnectedAt: null,
        }),
      ),
  }),
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
    expect(writeFileStringAtomically).toHaveBeenCalledTimes(1);
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
      Layer.mock(ThreadManagementService, {
        getShellSnapshot: () =>
          Effect.sync(() => {
            snapshotReads++;
            return {
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
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
function threadShell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe("2026-10-07T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-07T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const project: Project = {
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
  deletedAt: null,
};

const activityDependencies = (
  read: () => OrchestrationV2ThreadShell,
  events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.never,
) =>
  Layer.mergeAll(
    dependencies,
    Layer.mock(ProjectService, {
      getById: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
    }),
    Layer.mock(ThreadManagementService, {
      getThreadShell: () => Effect.sync(read),
      getShellSnapshot: () =>
        Effect.sync(() => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [read()],
          archivedThreads: [],
        })),
      streamDomainEvents: events,
    }),
  );

function observeDeliveries(delivered: Queue.Queue<ApplePushMessage>) {
  send.mockImplementation((message) =>
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Mock the Promise-based APNs transport with an observable delivery receipt.
    Effect.runPromise(
      Queue.offer(delivered, message).pipe(Effect.as({ ok: true, status: 200, reason: null })),
    ),
  );
}

it.effect("delivers V2 run completion while the phone is backgrounded", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const now = DateTime.toUtc(yield* DateTime.now);
    let thread = threadShell({ latestRunId: RunId.make("run-1"), updatedAt: now });
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        yield* push.register(principal, { ...registration, activityPushToken: "b".repeat(64) });
        observeDeliveries(delivered);
        thread = { ...thread, status: "completed", latestRunCompletedAt: now };
        yield* Queue.offer(events, {
          type: "run.updated",
          id: EventId.make("completion"),
          threadId: thread.id,
          occurredAt: now,
          payload: {
            id: RunId.make("run-1"),
            threadId: thread.id,
            ordinal: 1,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("user-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const card = yield* Queue.take(delivered);
        expect(card).toMatchObject({ kind: "liveactivity", payload: { aps: { event: "update" } } });
        const props = (card.payload as { aps: { "content-state": { props: string } } }).aps[
          "content-state"
        ].props;
        expect((yield* decodeCardStatus(props)).activities).toEqual([{ status: "Done" }]);
        expect((yield* decodeCardProps(props)).activities).toEqual([{ threadId: thread.id }]);
        expect(yield* Queue.take(delivered)).toMatchObject({
          kind: "alert",
          payload: { aps: { alert: { title: "Agent finished" } } },
        });
        yield* TestClock.adjust("16 minutes");
        const messages = send.mock.calls.map(([message]) => message);
        expect(messages.filter((message) => message.kind === "alert")).toHaveLength(1);
        expect(messages.at(-1)).toMatchObject({
          kind: "liveactivity",
          payload: { aps: { event: "end" } },
        });
      }),
      true,
      activityDependencies(() => thread, Stream.fromQueue(events)),
    );
  }),
);

it.effect("refreshes quiet work without alerts after the T3 Connect access token expires", () =>
  Effect.gen(function* () {
    const delivered = yield* Queue.unbounded<ApplePushMessage>();
    const now = DateTime.toUtc(yield* DateTime.now);
    const thread = threadShell({ latestRunId: RunId.make("run-1"), updatedAt: now });
    yield* run(
      Effect.gen(function* () {
        const push = yield* DirectPush;
        yield* push.register(cloudPrincipal, {
          ...registration,
          activityPushToken: "b".repeat(64),
        });
        activeSessions.clear();
        send.mockClear();
        observeDeliveries(delivered);
        yield* TestClock.adjust("65 minutes");
        expect(yield* Queue.take(delivered)).toMatchObject({ kind: "liveactivity", priority: 5 });
        expect(send.mock.calls.every(([message]) => message.kind === "liveactivity")).toBe(true);
        expect(yield* storedDevices).toEqual(["phone"]);
      }),
      true,
      activityDependencies(() => thread),
    );
  }),
);

it.effect("removes cloud subscriptions on revocation, unlinking or account replacement", () =>
  Effect.gen(function* () {
    for (const change of ["revoke", "unlink", "replace"] as const) {
      revokedSessions.clear();
      cloudAccount.id = "linked-user";
      yield* run(
        Effect.gen(function* () {
          const push = yield* DirectPush;
          yield* push.register(cloudPrincipal, registration);
          if (change === "revoke") revokedSessions.add("session-1");
          else cloudAccount.id = change === "unlink" ? null : "another-user";
          yield* push.register(principal, {
            ...registration,
            deviceId: "tablet",
            pushToken: "c".repeat(64),
          });
          expect(yield* storedDevices).toEqual(["tablet"]);
        }),
      );
    }
  }),
);
