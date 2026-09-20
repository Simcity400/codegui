import {
  AuthOrchestrationReadScope,
  DirectPushRegistration,
  EnvironmentHttpApi,
  type DirectPushStatus,
  type ThreadId,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  ApplePushConfiguration,
  createApplePushSender,
  type ApplePushMessage,
} from "./applePush.ts";
import {
  directActivityMessage,
  directPushAggregate,
  directPushAlert,
  type DirectPushThread,
} from "./directPushState.ts";

const Subscription = Schema.Struct({
  subject: Schema.String,
  sessionId: Schema.String,
  registration: DirectPushRegistration,
});
type Subscription = typeof Subscription.Type;

class DirectPushError extends Schema.TaggedError<DirectPushError>()("DirectPushError", {
  message: Schema.String,
}) {}

export class DirectPush extends Context.Service<
  DirectPush,
  {
    readonly register: (
      principal: EnvironmentSessionPrincipalShape,
      input: DirectPushRegistration,
    ) => Effect.Effect<DirectPushStatus, DirectPushError>;
    readonly unregister: (
      subject: string,
      deviceId: string,
    ) => Effect.Effect<void, DirectPushError>;
  }
>()("t3/notifications/DirectPush") {}

export const layer = Layer.effect(
  DirectPush,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const environment = yield* ServerEnvironment;
    const sessions = yield* SessionStore;
    const lock = yield* Semaphore.make(1);
    const credentialsPath = path.join(config.baseDir, "apple-push.json");
    const subscriptionsPath = path.join(config.stateDir, "mobile-push.json");
    const credentials = yield* fs
      .readFileString(credentialsPath)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApplePushConfiguration))),
        Effect.option,
      );
    const sender = yield* Effect.try(() =>
      Option.isSome(credentials) ? createApplePushSender(credentials.value) : null,
    ).pipe(Effect.option);
    if (Option.isNone(credentials) || Option.isNone(sender) || sender.value === null) {
      return DirectPush.of({
        register: () =>
          Effect.succeed({
            configured: false,
            aggregate: null,
            deliveryError: "Apple push delivery is not configured on this server.",
          }),
        unregister: () => Effect.void,
      });
    }
    const send = sender.value;
    const subscriptions = new Map<string, Subscription>();
    const errors = new Map<string, string>();
    const verifiedPushTokens = new Set<string>();
    const threads = new Map<ThreadId, DirectPushThread>();
    const loaded = yield* fs.readFileString(subscriptionsPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Subscription)))),
      Effect.orElseSucceed(() => []),
    );
    const deviceKey = (subject: string, deviceId: string) =>
      `${subject.length}:${subject}${deviceId}`;
    for (const device of loaded)
      subscriptions.set(deviceKey(device.subject, device.registration.deviceId), device);
    const encodeSubscriptions = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Subscription)),
    );
    const persist = () =>
      encodeSubscriptions([...subscriptions.values()]).pipe(
        Effect.flatMap((contents) =>
          writeFileStringAtomically({ filePath: subscriptionsPath, contents }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          () => new DirectPushError({ message: "Could not save notification registrations." }),
        ),
      );
    const environmentId = yield* environment.getEnvironmentId;
    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* snapshotQuery.getThreadShellById(threadId);
        if (Option.isNone(thread)) return null;
        const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId);
        if (Option.isNone(project)) return null;
        const state = projectThreadAwareness({
          environmentId,
          project: project.value,
          thread: thread.value,
        });
        return state ? { state, turnId: thread.value.latestTurn?.turnId ?? null } : null;
      });
    const readSnapshot = Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const result = new Map<ThreadId, DirectPushThread>();
      const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
      for (const thread of snapshot.threads) {
        const project = projects.get(thread.projectId);
        if (!project) continue;
        const state = projectThreadAwareness({ environmentId, project, thread });
        if (state) result.set(thread.id, { state, turnId: thread.latestTurn?.turnId ?? null });
      }
      return result;
    });
    const seed = readSnapshot.pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          for (const [id, thread] of snapshot) threads.set(id, thread);
        }),
      ),
    );
    const deliver = (key: string, message: ApplePushMessage) =>
      Effect.tryPromise({
        try: () => send(message),
        catch: () => new DirectPushError({ message: "Could not reach Apple push service." }),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const errorKey = `${key}:${message.kind === "liveactivity" ? "liveactivity" : "alert"}`;
            if (result.ok) errors.delete(errorKey);
            else
              errors.set(
                errorKey,
                `Apple rejected ${message.kind}: ${result.reason ?? result.status}`,
              );
            if (result.ok && message.kind !== "liveactivity") verifiedPushTokens.add(message.token);
            if (
              result.status === 410 ||
              result.reason === "BadDeviceToken" ||
              result.reason === "DeviceTokenNotForTopic"
            ) {
              const device = subscriptions.get(key);
              if (device)
                subscriptions.set(key, {
                  ...device,
                  registration: {
                    ...device.registration,
                    ...(message.kind === "liveactivity"
                      ? { activityPushToken: null }
                      : { pushToken: null }),
                  },
                });
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            errors.set(
              `${key}:${message.kind === "liveactivity" ? "liveactivity" : "alert"}`,
              error.message,
            );
          }),
        ),
        Effect.asVoid,
      );
    const publish = (threadId: ThreadId) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const previous = threads.get(threadId);
            const next = yield* readThread(threadId);
            if (next) threads.set(threadId, next);
            else threads.delete(threadId);
            if (
              previous?.turnId === next?.turnId &&
              previous?.state.phase === next?.state.phase &&
              previous?.state.threadTitle === next?.state.threadTitle &&
              previous?.state.modelTitle === next?.state.modelTitle
            )
              return;
            const alert = directPushAlert(previous, next);
            const now = yield* Clock.currentTimeMillis;
            const aggregate = directPushAggregate(threads.values(), now);
            for (const [key, device] of subscriptions) {
              const registration = device.registration;
              const activity = directActivityMessage(registration, aggregate, now);
              if (activity) yield* deliver(key, activity);
              if (alert && registration.notificationsEnabled && registration.pushToken) {
                yield* deliver(key, {
                  token: registration.pushToken,
                  environment: registration.apsEnvironment,
                  kind: "alert",
                  payload: alert,
                });
              }
            }
            yield* persist();
          }),
        )
        .pipe(Effect.catchCause(() => Effect.logWarning("Direct Apple push update failed.")));
    const worker = yield* makeDrainableWorker(publish);
    const events = yield* engine.subscribeDomainEvents;
    yield* seed.pipe(
      Effect.catchCause(() => Effect.logWarning("Direct Apple push initial snapshot failed.")),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        const threadId = eventThreadId(event);
        return threadId && shouldPublishAgentAwarenessEvent(event)
          ? worker.enqueue(threadId)
          : Effect.void;
      }).pipe(
        Effect.catchCause(() => Effect.logError("Direct Apple push event subscription failed.")),
      ),
    );
    yield* forkParked(
      Stream.runForEach(sessions.streamChanges, (event) => {
        if (event.type !== "clientRemoved") return Effect.void;
        return lock
          .withPermit(
            Effect.gen(function* () {
              for (const [key, device] of subscriptions)
                if (device.sessionId === event.sessionId) subscriptions.delete(key);
              yield* persist();
            }),
          )
          .pipe(
            Effect.catchCause(() => Effect.logWarning("Direct Apple push session cleanup failed.")),
          );
      }),
    );
    return DirectPush.of({
      register: (principal, registration) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (registration.bundleId !== credentials.value.bundleId)
              return {
                configured: false,
                aggregate: null,
                deliveryError: "This server's Apple push key is configured for a different app.",
              };
            const snapshot = yield* readSnapshot.pipe(
              Effect.mapError(
                () => new DirectPushError({ message: "Could not read current agent activity." }),
              ),
            );
            const key = deviceKey(principal.subject, registration.deviceId);
            const previous = subscriptions.get(key);
            // A native token can only belong to one device registration at a time.
            for (const [otherKey, other] of subscriptions)
              if (
                otherKey !== key &&
                registration.pushToken &&
                other.registration.pushToken === registration.pushToken
              )
                subscriptions.delete(otherKey);
            subscriptions.set(key, {
              subject: principal.subject,
              sessionId: principal.sessionId,
              registration,
            });
            // Verify a new notification token with Apple without displaying a banner.
            if (
              registration.notificationsEnabled &&
              registration.pushToken &&
              (previous?.registration.pushToken !== registration.pushToken ||
                !verifiedPushTokens.has(registration.pushToken) ||
                errors.has(`${key}:alert`))
            ) {
              yield* deliver(key, {
                kind: "background",
                token: registration.pushToken,
                environment: registration.apsEnvironment,
                payload: { aps: { "content-available": 1 } },
              });
            }
            const now = yield* Clock.currentTimeMillis;
            const aggregate = directPushAggregate(snapshot.values(), now);
            const activity = directActivityMessage(registration, aggregate, now);
            if (activity) yield* deliver(key, activity);
            yield* persist();
            return {
              configured: true,
              aggregate,
              deliveryError:
                errors.get(`${key}:alert`) ?? errors.get(`${key}:liveactivity`) ?? null,
            };
          }),
        ),
      unregister: (subject, deviceId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const key = deviceKey(subject, deviceId);
            const device = subscriptions.get(key);
            if (device) {
              const message = directActivityMessage(
                { ...device.registration, liveActivitiesEnabled: false },
                null,
                yield* Clock.currentTimeMillis,
              );
              if (message) yield* deliver(key, message);
            }
            subscriptions.delete(key);
            errors.delete(`${key}:alert`);
            errors.delete(`${key}:liveactivity`);
            yield* persist();
          }),
        ),
    });
  }),
);

export const httpLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mobilePush",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* DirectPush;
    return handlers
      .handle(
        "register",
        Effect.fn("mobilePush.register")(function* ({ payload }) {
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* push
            .register(principal, payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "unregister",
        Effect.fn("mobilePush.unregister")(function* ({ payload }) {
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* push
            .unregister(principal.subject, payload.deviceId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return { ok: true };
        }),
      );
  }),
);
