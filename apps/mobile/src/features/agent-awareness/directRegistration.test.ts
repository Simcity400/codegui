import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { DirectPushRegistration, DirectPushStatus, EnvironmentId } from "@t3tools/contracts";
import type { SavedRemoteConnection } from "../../lib/connection";

const mocks = vi.hoisted(() => ({
  granted: true,
  liveEnabled: true,
  saved: null as string | null,
  getToken: vi.fn(() => Promise.resolve({ type: "ios", data: "a".repeat(64) })),
  registered: [] as Array<{
    url: string;
    payload: DirectPushRegistration;
    headers: { authorization: string; dpop?: string };
  }>,
  proof: vi.fn(() => Effect.succeed("device-proof")),
  unregistered: [] as string[],
  response: { configured: true, aggregate: null, deliveryError: null } as DirectPushStatus,
  instances: [] as Array<{
    getId: () => string;
    getPushToken: () => Promise<string>;
    addPushTokenListener: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      ios: { bundleIdentifier: "com.simcity400.t3code.preview" },
      extra: { appVariant: "preview" },
    },
  },
}));
vi.mock("./capabilities", () => ({ supportsAgentAwarenessPush: () => true }));
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: () => Promise.resolve({ granted: mocks.granted }),
  getDevicePushTokenAsync: mocks.getToken,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: () => Promise.resolve(mocks.saved),
  setItemAsync: (_key: string, value: string) => {
    mocks.saved = value;
    return Promise.resolve();
  },
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: () => Promise.resolve("phone"),
  loadPreferences: () => Promise.resolve({ liveActivitiesEnabled: mocks.liveEnabled }),
}));
vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromise: (operation: Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayDpopSigner>) =>
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise the imperative mobile lifecycle through its Promise-based runtime boundary.
      Effect.runPromise(
        operation.pipe(
          Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
            thumbprint: Effect.succeed("thumbprint"),
            createProof: mocks.proof,
          }),
        ),
      ),
  },
}));
vi.mock("@t3tools/client-runtime/rpc", async (original) => ({
  ...(await original<object>()),
  makeEnvironmentHttpApiClient: (url: string) =>
    Effect.succeed({
      mobilePush: {
        register: ({
          payload,
          headers,
        }: {
          payload: DirectPushRegistration;
          headers: { authorization: string; dpop?: string };
        }) =>
          Effect.sync(() => {
            mocks.registered.push({ url, payload, headers });
            return mocks.response;
          }),
        unregister: () =>
          Effect.sync(() => {
            mocks.unregistered.push(url);
            return { ok: true };
          }),
      },
    }),
}));
vi.mock("./agentLiveActivity", () => ({
  getAgentLiveActivities: () => mocks.instances,
  startAgentLiveActivity: () => {
    const id = `activity-${mocks.instances.length + 1}`;
    const instance = {
      getId: () => id,
      getPushToken: () => Promise.resolve(id === "activity-1" ? "b".repeat(64) : "c".repeat(64)),
      addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
      update: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
    };
    mocks.instances.push(instance);
    return instance;
  },
}));
function connection(id = "env-1"): SavedRemoteConnection {
  return {
    environmentId: id as EnvironmentId,
    environmentLabel: id,
    pairingUrl: `https://${id}.test/pair`,
    displayUrl: `https://${id}.test`,
    httpBaseUrl: `https://${id}.test`,
    wsBaseUrl: `wss://${id}.test/ws`,
    bearerToken: "session-token",
  };
}
beforeEach(() => {
  vi.resetModules();
  mocks.granted = true;
  mocks.liveEnabled = true;
  mocks.saved = null;
  mocks.instances = [];
  mocks.registered = [];
  mocks.unregistered = [];
  mocks.getToken.mockClear();
  mocks.proof.mockClear();
  mocks.response = { configured: true, aggregate: null, deliveryError: null };
});
describe("personal iPhone direct registration", () => {
  it("authenticates T3 Connect registration with the device's DPoP proof", async () => {
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([
      {
        ...connection(),
        bearerToken: null,
        authenticationMethod: "dpop",
        dpopAccessToken: "cloud-token",
      },
    ]);
    expect(mocks.registered[0]?.headers).toEqual({
      authorization: "DPoP cloud-token",
      dpop: "device-proof",
    });
    expect(mocks.proof).toHaveBeenCalledWith({
      method: "POST",
      url: "https://env-1.test/api/mobile-push/register",
      accessToken: "cloud-token",
    });
    expect(client.getDirectPushStatus().ready).toBe(true);
  });
  it("registers with the authenticated environment and uses production APNs for preview", async () => {
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection()]);
    expect(mocks.registered[0]).toMatchObject({
      url: "https://env-1.test",
      payload: {
        bundleId: "com.simcity400.t3code.preview",
        apsEnvironment: "production",
        pushToken: "a".repeat(64),
        notificationsEnabled: true,
      },
    });
    expect(client.getDirectPushStatus()).toMatchObject({ ready: true, error: null });
  });
  it("reports Apple delivery failures instead of claiming notifications are ready", async () => {
    mocks.response = {
      ...mocks.response,
      deliveryError: "Apple rejected alert: InvalidProviderToken",
    };
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection()]);
    expect(client.getDirectPushStatus()).toMatchObject({
      ready: false,
      error: mocks.response.deliveryError,
    });
  });
  it("keeps each environment's Live Activity token separate", async () => {
    mocks.response = {
      ...mocks.response,
      aggregate: {
        title: "T3 Code",
        subtitle: "Working",
        activeCount: 1,
        updatedAt: "2026-09-20T00:00:00.000Z",
        activities: [],
      },
    };
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection(), connection("env-2")]);
    expect(mocks.instances).toHaveLength(2);
    expect(
      mocks.registered.filter((entry) => entry.payload.activityPushToken !== null),
    ).toMatchObject([
      { url: "https://env-1.test", payload: { activityPushToken: "b".repeat(64) } },
      { url: "https://env-2.test", payload: { activityPushToken: "c".repeat(64) } },
    ]);
    mocks.liveEnabled = false;
    await client.refreshDirectPushRegistration();
    expect(mocks.instances.every((activity) => activity.end.mock.calls.length > 0)).toBe(true);
    expect(mocks.registered.at(-1)?.payload.liveActivitiesEnabled).toBe(false);
  });
  it("disables ordinary alerts after system permission is revoked", async () => {
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection()]);
    mocks.granted = false;
    await client.refreshDirectPushRegistration();
    expect(mocks.registered.at(-1)?.payload).toMatchObject({
      pushToken: null,
      notificationsEnabled: false,
    });
    expect(client.getDirectPushStatus().notificationsEnabled).toBe(false);
  });
  it("unregisters a removed environment", async () => {
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection()]);
    await client.setDirectPushConnections([]);
    expect(mocks.unregistered).toEqual(["https://env-1.test"]);
    expect(client.getDirectPushStatus().ready).toBe(false);
  });
  it("does not refetch or reregister for an unchanged native token event", async () => {
    const client = await import("./directRegistration");
    await client.setDirectPushConnections([connection()]);
    client.observeDirectPushToken({ type: "ios", data: "a".repeat(64) });
    expect(mocks.registered).toHaveLength(1);
    expect(mocks.getToken).toHaveBeenCalledTimes(1);
  });
});
