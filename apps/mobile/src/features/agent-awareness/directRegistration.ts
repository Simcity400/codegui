import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import type { LiveActivity } from "expo-widgets";
import * as Effect from "effect/Effect";
import {
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "@t3tools/client-runtime/rpc";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { DirectPushRegistration, DirectPushStatus } from "@t3tools/contracts";
import { AppState } from "react-native";
import type { SavedRemoteConnection } from "../../lib/connection";
import { runtime } from "../../lib/runtime";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import { getAgentLiveActivities, startAgentLiveActivity } from "./agentLiveActivity";
import { resolveApsEnvironment } from "./registrationPayload";

const ACTIVITY_IDS_KEY = "t3code.directPush.activityIds";
const connections = new Map<string, SavedRemoteConnection>();
const activities = new Map<string, LiveActivity<AgentActivityProps>>();
const tokenListeners = new Map<string, { remove: () => void }>();
const listeners = new Set<() => void>();
let restored = false;
let pending: Promise<void> | null = null;
let refreshAgain = false;
let observedPushToken: string | null = null;
let status = {
  ready: false,
  notificationsEnabled: false,
  error: "Connecting to your server…" as string | null,
};

export const getDirectPushStatus = () => status;
export const subscribeDirectPushStatus = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setStatus(next: typeof status) {
  status = next;
  for (const listener of listeners) listener();
}

function register(
  connection: SavedRemoteConnection,
  payload: DirectPushRegistration,
): Promise<DirectPushStatus> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
      const headers = yield* authorizationHeaders(connection, "register");
      return yield* client.mobilePush.register({
        headers,
        payload,
      });
    }).pipe(Effect.timeout("30 seconds")),
  );
}

const authorizationHeaders = Effect.fnUntraced(function* (
  connection: SavedRemoteConnection,
  endpoint: "register" | "unregister",
) {
  if (connection.authenticationMethod === "dpop" && connection.dpopAccessToken) {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const url = makeEnvironmentHttpApiUrlBuilder(connection.httpBaseUrl).mobilePush[endpoint]();
    const proof = yield* signer.createProof({
      method: "POST",
      url,
      accessToken: connection.dpopAccessToken,
    });
    return { authorization: `DPoP ${connection.dpopAccessToken}`, dpop: proof };
  }
  return { authorization: `Bearer ${connection.bearerToken}` };
});

async function restoreActivities() {
  if (restored) return;
  const saved = await SecureStore.getItemAsync(ACTIVITY_IDS_KEY);
  let ids: unknown = {};
  try {
    ids = saved ? JSON.parse(saved) : {};
  } catch {
    /* Recreate an invalid device-local activity index. */
  }
  const instances = getAgentLiveActivities();
  if (ids && typeof ids === "object") {
    for (const [environmentId, id] of Object.entries(ids)) {
      const instance = instances.find((activity) => activity.getId() === id);
      if (instance) activities.set(environmentId, instance);
    }
  }
  // Cards from the former relay path cannot receive our direct updates.
  const owned = new Set([...activities.values()].map((activity) => activity.getId()));
  await Promise.all(
    instances
      .filter((activity) => !owned.has(activity.getId()))
      .map((activity) => activity.end("immediate")),
  );
  restored = true;
}

async function persistActivities() {
  await SecureStore.setItemAsync(
    ACTIVITY_IDS_KEY,
    JSON.stringify(
      Object.fromEntries(
        [...activities].map(([environmentId, activity]) => [environmentId, activity.getId()]),
      ),
    ),
  );
}

async function refreshNow() {
  await restoreActivities();
  const [deviceId, preferences, permission] = await Promise.all([
    loadOrCreateAgentAwarenessDeviceId(),
    loadPreferences(),
    Notifications.getPermissionsAsync(),
  ]);
  if (permission.granted && !observedPushToken) {
    const nativeToken = await Notifications.getDevicePushTokenAsync();
    observedPushToken =
      nativeToken.type === "ios" && typeof nativeToken.data === "string" ? nativeToken.data : null;
  }
  const pushToken = permission.granted ? observedPushToken : null;
  const liveEnabled = preferences.liveActivitiesEnabled !== false;
  const failures: string[] = [];
  let registered = 0;
  for (const [environmentId, connection] of connections) {
    if (!connection.bearerToken && !connection.dpopAccessToken) continue;
    try {
      let activity = activities.get(environmentId);
      if (
        activity &&
        !getAgentLiveActivities().some((current) => current.getId() === activity?.getId())
      ) {
        tokenListeners.get(environmentId)?.remove();
        tokenListeners.delete(environmentId);
        activities.delete(environmentId);
        activity = undefined;
      }
      const payload: DirectPushRegistration = {
        deviceId,
        bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? "",
        apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
        pushToken,
        activityPushToken: activity ? await activity.getPushToken() : null,
        notificationsEnabled: permission.granted && pushToken !== null,
        liveActivitiesEnabled: liveEnabled,
      };
      let result = await register(connection, payload);
      if (connections.get(environmentId) !== connection) continue;
      if (!result.configured) {
        failures.push(result.deliveryError ?? "Configure Apple push delivery on your server.");
        continue;
      }
      registered++;
      if (!liveEnabled || !result.aggregate || result.aggregate.activeCount === 0) {
        if (activity) {
          await activity.end(
            result.aggregate && liveEnabled
              ? { after: new Date(Date.now() + 900000) }
              : "immediate",
            result.aggregate ?? undefined,
          );
          activities.delete(environmentId);
          tokenListeners.get(environmentId)?.remove();
          tokenListeners.delete(environmentId);
        }
      } else if (AppState.currentState === "active") {
        if (activity) await activity.update(result.aggregate);
        else {
          activity = startAgentLiveActivity(result.aggregate) ?? undefined;
          if (activity) activities.set(environmentId, activity);
        }
        if (activity && !tokenListeners.has(environmentId)) {
          let observedActivityToken = await activity.getPushToken();
          tokenListeners.set(
            environmentId,
            activity.addPushTokenListener((event) => {
              if (event.pushToken === observedActivityToken) return;
              observedActivityToken = event.pushToken;
              void refreshDirectPushRegistration();
            }),
          );
        }
        const activityPushToken = activity ? await activity.getPushToken() : null;
        if (activityPushToken && activityPushToken !== payload.activityPushToken) {
          result = await register(connection, { ...payload, activityPushToken });
        }
      }
      if (result.deliveryError) failures.push(result.deliveryError);
    } catch {
      failures.push(
        `Could not register notifications with ${connection.environmentLabel ?? "your server"}. Update the server and check its connection.`,
      );
    }
  }
  await persistActivities();
  setStatus({
    ready: registered > 0 && failures.length === 0,
    notificationsEnabled: permission.granted && pushToken !== null,
    error:
      failures[0] ??
      (registered === 0 ? "Connect to your T3 server to enable notifications." : null),
  });
}

/** Collapse simultaneous connection, permission, and native-token refreshes. */
export function refreshDirectPushRegistration(): Promise<void> {
  if (pending) {
    refreshAgain = true;
    return pending;
  }
  pending = (async () => {
    do {
      refreshAgain = false;
      try {
        await refreshNow();
      } catch {
        setStatus({
          ready: false,
          notificationsEnabled: false,
          error: "Could not register this iPhone for notifications.",
        });
      }
    } while (refreshAgain);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export function observeDirectPushToken(token: Notifications.DevicePushToken) {
  if (token.type !== "ios" || typeof token.data !== "string" || token.data === observedPushToken)
    return;
  observedPushToken = token.data;
  void refreshDirectPushRegistration();
}

export async function setDirectPushConnections(next: ReadonlyArray<SavedRemoteConnection>) {
  try {
    const nextIds = new Set<string>(next.map((connection) => connection.environmentId));
    const removed = [...connections].filter(([environmentId]) => !nextIds.has(environmentId));
    connections.clear();
    for (const connection of next) connections.set(connection.environmentId, connection);
    // Finish an in-flight registration before unregistering its removed environment.
    if (pending) await pending;
    for (const [environmentId, connection] of removed) {
      if (connections.has(environmentId)) continue;
      tokenListeners.get(environmentId)?.remove();
      tokenListeners.delete(environmentId);
      await activities.get(environmentId)?.end("immediate");
      activities.delete(environmentId);
      const deviceId = await loadOrCreateAgentAwarenessDeviceId();
      await runtime
        .runPromise(
          Effect.gen(function* () {
            const client = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
            const headers = yield* authorizationHeaders(connection, "unregister");
            yield* client.mobilePush.unregister({ headers, payload: { deviceId } });
          }).pipe(Effect.timeout("30 seconds")),
        )
        .catch(() => undefined);
    }
    await refreshDirectPushRegistration();
  } catch {
    setStatus({
      ready: false,
      notificationsEnabled: false,
      error: "Could not update notification connections.",
    });
  }
}
