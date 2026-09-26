import {
  AuthOrchestrationReadScope,
  DirectPushRegistration,
  EnvironmentHttpApi,
  type DirectPushStatus,
  type ThreadId,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
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
  type ApplePushResult,
} from "./applePush.ts";
import {
  DIRECT_PUSH_FINISHED_DISPLAY_MS,
  directActivityMessage,
  directPushAggregate,
  directPushAlert,
  directPushThread,
  type DirectPushThread,
} from "./directPushState.ts";

const Subscription = Schema.Struct({
  subject: Schema.String,
  sessionId: Schema.String,
  registration: DirectPushRegistration,
});
type Subscription = typeof Subscription.Type;

// Paired clients often share a subject, so this is a per-owner budget rather
// than per phone. Room for a few phones and tablets plus a reinstall or two.
const MAX_DEVICES_PER_SUBJECT = 5;

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
    const scope = yield* Effect.scope;
    const credentialsPath = path.join(config.baseDir, "apple-push.json");
    const subscriptionsPath = path.join(config.stateDir, "mobile-push.json");
    const credentials = yield* fs
      .readFileString(credentialsPath)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApplePushConfiguration))),
        Effect.option,
      );
    // The file holds the APNs signing key, which can push to every install of the app.
    if (Option.isSome(credentials) && (yield* HostProcessPlatform) !== "win32")
      yield* fs.stat(credentialsPath).pipe(
        Effect.flatMap((info) =>
          (info.mode & 0o077) === 0
            ? Effect.void
            : Effect.logWarning(
                `${credentialsPath} is accessible to other accounts; restrict it with chmod 600.`,
              ),
        ),
        Effect.ignore,
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
    // A device with no token left cannot be reached until it registers again.
    const store = (key: string, device: Subscription) => {
      if (device.registration.pushToken || device.registration.activityPushToken)
        subscriptions.set(key, device);
      else subscriptions.delete(key);
    };
    const forget = (key: string) => {
      subscriptions.delete(key);
      errors.delete(`${key}:alert`);
      errors.delete(`${key}:liveactivity`);
    };
    // Deliveries end with the session that registered the device. Revoking
    // from the CLI (another process) and plain expiry emit no session change
    // here, so the session table is checked before anything is sent.
    const pruneInactiveSessions = Effect.gen(function* () {
      if (subscriptions.size === 0) return false;
      const active = new Set<string>(
        (yield* sessions.listActive()).map((session) => session.sessionId),
      );
      let pruned = false;
      for (const [key, device] of subscriptions)
        if (!active.has(device.sessionId)) {
          forget(key);
          pruned = true;
        }
      return pruned;
    });
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
    yield* pruneInactiveSessions.pipe(
      Effect.flatMap((pruned) => (pruned ? persist() : Effect.void)),
      Effect.catchCause(() => Effect.logWarning("Direct Apple push session check failed.")),
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
        return state ? directPushThread(state, thread.value) : null;
      });
    const readSnapshot = Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const result = new Map<ThreadId, DirectPushThread>();
      const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
      for (const thread of snapshot.threads) {
        const project = projects.get(thread.projectId);
        if (!project) continue;
        const state = projectThreadAwareness({ environmentId, project, thread });
        if (state) result.set(thread.id, directPushThread(state, thread));
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
    const request = (message: ApplePushMessage) =>
      Effect.tryPromise({
        try: () => send(message),
        catch: () => new DirectPushError({ message: "Could not reach Apple push service." }),
      }).pipe(Effect.result);
    // Applies Apple's answer to the device's current registration.
    const record = (
      key: string,
      message: ApplePushMessage,
      outcome: Result.Result<ApplePushResult, DirectPushError>,
    ) => {
      const errorKey = `${key}:${message.kind === "liveactivity" ? "liveactivity" : "alert"}`;
      if (Result.isFailure(outcome)) {
        errors.set(errorKey, outcome.failure.message);
        return;
      }
      const result = outcome.success;
      if (result.ok) errors.delete(errorKey);
      else
        errors.set(errorKey, `Apple rejected ${message.kind}: ${result.reason ?? result.status}`);
      if (result.ok && message.kind !== "liveactivity") verifiedPushTokens.add(message.token);
      if (
        result.status === 410 ||
        result.reason === "BadDeviceToken" ||
        result.reason === "DeviceTokenNotForTopic"
      ) {
        const device = subscriptions.get(key);
        const field = message.kind === "liveactivity" ? "activityPushToken" : "pushToken";
        if (device && device.registration[field] === message.token)
          store(key, { ...device, registration: { ...device.registration, [field]: null } });
      }
    };
    const deliver = (key: string, message: ApplePushMessage) =>
      request(message).pipe(Effect.map((outcome) => record(key, message, outcome)));
    // An ended card ignores later pushes, so its token is forgotten until the
    // phone starts a new card and registers again.
    const deliverActivity = (
      key: string,
      aggregate: RelayAgentActivityAggregateState | null,
      now: number,
    ) =>
      Effect.gen(function* () {
        const device = subscriptions.get(key);
        const message = device && directActivityMessage(device.registration, aggregate, now);
        if (!device || !message) return;
        yield* deliver(key, message);
        const current = subscriptions.get(key);
        if (current && (!device.registration.liveActivitiesEnabled || aggregate === null))
          store(key, {
            ...current,
            registration: { ...current.registration, activityPushToken: null },
          });
      });
    // No event arrives when the last Done row expires, so revisit the card then.
    const endFinishedCardsLater = Effect.sleep(DIRECT_PUSH_FINISHED_DISPLAY_MS + 1_000).pipe(
      Effect.andThen(
        lock.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (directPushAggregate(threads.values(), now) !== null) return;
            yield* pruneInactiveSessions;
            for (const key of subscriptions.keys()) yield* deliverActivity(key, null, now);
            yield* persist();
          }),
        ),
      ),
      Effect.catchCause(() => Effect.logWarning("Direct Apple push card expiry failed.")),
      Effect.forkIn(scope),
    );
    const publish = (threadId: ThreadId) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const previous = threads.get(threadId);
            const next = yield* readThread(threadId);
            // Like the relay's publish identity, only these fields count. Keep
            // the previous state otherwise: settling a finished thread bumps
            // its updatedAt, which would put a fresh Done row back on the card.
            if (
              previous?.turnId === next?.turnId &&
              previous?.state.phase === next?.state.phase &&
              previous?.state.threadTitle === next?.state.threadTitle &&
              previous?.state.modelTitle === next?.state.modelTitle &&
              previous?.monitoring === next?.monitoring
            )
              return;
            if (next) threads.set(threadId, next);
            else threads.delete(threadId);
            const alert = directPushAlert(previous, next);
            const now = yield* Clock.currentTimeMillis;
            const aggregate = directPushAggregate(threads.values(), now);
            if (aggregate?.activeCount === 0) yield* endFinishedCardsLater;
            yield* pruneInactiveSessions;
            for (const [key, device] of subscriptions) {
              const registration = device.registration;
              yield* deliverActivity(key, aggregate, now);
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
    // Publishes queued or running per thread. A task that ends while its
    // thread's turn-completion publish is still reading must still republish.
    const publishing = new Map<ThreadId, number>();
    const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
      publish(threadId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const count = (publishing.get(threadId) ?? 1) - 1;
            if (count > 0) publishing.set(threadId, count);
            else publishing.delete(threadId);
          }),
        ),
      ),
    );
    const events = yield* engine.subscribeDomainEvents;
    yield* seed.pipe(
      Effect.catchCause(() => Effect.logWarning("Direct Apple push initial snapshot failed.")),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        const threadId = eventThreadId(event);
        if (!threadId) return Effect.void;
        // Task starts and ends move a finished thread between Monitoring and
        // Done; while its turn runs they cannot change the card.
        const previous = threads.get(threadId);
        const movesFinishedThread =
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind.startsWith("task.") &&
          (previous?.monitoring === true ||
            previous?.state.phase === "completed" ||
            publishing.has(threadId));
        if (!shouldPublishAgentAwarenessEvent(event) && !movesFinishedThread) return Effect.void;
        publishing.set(threadId, (publishing.get(threadId) ?? 0) + 1);
        return worker.enqueue(threadId);
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
                if (device.sessionId === event.sessionId) forget(key);
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
        Effect.gen(function* () {
          if (registration.bundleId !== credentials.value.bundleId)
            return {
              configured: false,
              aggregate: null,
              deliveryError: "This server's Apple push key is configured for a different app.",
            };
          const key = deviceKey(principal.subject, registration.deviceId);
          const previous = subscriptions.get(key);
          // Verify a new notification token with Apple without displaying a
          // banner. Apple is asked outside the lock so a slow answer never
          // holds up other devices' updates.
          const verification: ApplePushMessage | null =
            registration.notificationsEnabled &&
            registration.pushToken &&
            (previous?.registration.pushToken !== registration.pushToken ||
              !verifiedPushTokens.has(registration.pushToken) ||
              errors.has(`${key}:alert`))
              ? {
                  kind: "background",
                  token: registration.pushToken,
                  environment: registration.apsEnvironment,
                  payload: { aps: { "content-available": 1 } },
                }
              : null;
          const verified = verification ? yield* request(verification) : null;
          // Let the worker apply the events it has already received, so the
          // aggregate is not behind a change the phone reacted to.
          yield* worker.drain.pipe(Effect.timeoutOption("5 seconds"));
          return yield* lock.withPermit(
            Effect.gen(function* () {
              yield* pruneInactiveSessions.pipe(
                Effect.mapError(
                  () => new DirectPushError({ message: "Could not check client sessions." }),
                ),
              );
              // A native token can only belong to one device registration at a time.
              for (const [otherKey, other] of subscriptions)
                if (
                  otherKey !== key &&
                  registration.pushToken &&
                  other.registration.pushToken === registration.pushToken
                )
                  forget(otherKey);
              // Re-inserting keeps the map ordered from least to most recently registered.
              subscriptions.delete(key);
              store(key, {
                subject: principal.subject,
                sessionId: principal.sessionId,
                registration,
              });
              if (verification && verified) record(key, verification, verified);
              // Past the cap the stalest registration goes (an old phone or a
              // reinstall's abandoned id), so a new device never gets locked out.
              const owned = [...subscriptions.entries()].filter(
                ([, device]) => device.subject === principal.subject,
              );
              for (const [staleKey] of owned.slice(0, -MAX_DEVICES_PER_SUBJECT)) forget(staleKey);
              // `threads` is kept current by the event worker, so registering
              // never rebuilds the shell snapshot (a full read that also spawns
              // git to resolve repository identities).
              const now = yield* Clock.currentTimeMillis;
              const aggregate = directPushAggregate(threads.values(), now);
              yield* deliverActivity(key, aggregate, now);
              yield* persist();
              const deliveryError =
                errors.get(`${key}:alert`) ?? errors.get(`${key}:liveactivity`) ?? null;
              if (!subscriptions.has(key)) forget(key);
              return { configured: true, aggregate, deliveryError };
            }),
          );
        }),
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
            forget(key);
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
