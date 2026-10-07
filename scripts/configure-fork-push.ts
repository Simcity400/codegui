// @effect-diagnostics nodeBuiltinImport:off - Personal push integration is applied in isolated build checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const DIRECT_PUSH_PATHS = [
  "scripts/configure-fork-push.ts",
  "scripts/configure-fork-push.test.ts",
  "apps/server/src/notifications/DirectPush.ts",
  "apps/server/src/notifications/DirectPush.test.ts",
  "apps/server/src/notifications/applePush.ts",
  "apps/server/src/notifications/directPushState.ts",
  "apps/server/src/notifications/directPushState.test.ts",
  "apps/mobile/src/features/agent-awareness/directRegistration.ts",
  "apps/mobile/src/features/agent-awareness/directRegistration.test.ts",
  "apps/mobile/src/features/agent-awareness/DirectPushCoordinator.tsx",
  "apps/mobile/src/features/settings/DirectPushSettings.tsx",
] as const;

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(`Personal push integration changed upstream; review: ${before}`);
  return source.replace(before, after);
}

/** Add the authenticated endpoints without replacing upstream contracts. */
export function configurePushContracts(source: string): string {
  if (source.includes(".add(EnvironmentMobilePushHttpApi)")) return source;
  source = replaceOnce(
    source,
    "  RelayCloudEnvironmentHealthRequest,",
    "  RelayAgentActivityAggregateState,\n  RelayCloudEnvironmentHealthRequest,",
  );
  const contracts = `export const DirectPushRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: Schema.Literals(["sandbox", "production"]),
  pushToken: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32,512}$/))),
  activityPushToken: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32,512}$/))),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
});
export type DirectPushRegistration = typeof DirectPushRegistration.Type;
export const DirectPushStatus = Schema.Struct({
  configured: Schema.Boolean,
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  deliveryError: Schema.NullOr(Schema.String),
});
export type DirectPushStatus = typeof DirectPushStatus.Type;
class EnvironmentMobilePushHttpApi extends HttpApiGroup.make("mobilePush")
  .add(HttpApiEndpoint.post("register", "/api/mobile-push/register", {
    headers: OptionalBearerHeaders,
    payload: DirectPushRegistration,
    success: DirectPushStatus,
    error: [EnvironmentInternalError, EnvironmentScopeRequiredError],
  }).middleware(EnvironmentAuthenticatedAuth))
  .add(HttpApiEndpoint.post("unregister", "/api/mobile-push/unregister", {
    headers: OptionalBearerHeaders,
    payload: Schema.Struct({ deviceId: TrimmedNonEmptyString }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: [EnvironmentInternalError, EnvironmentScopeRequiredError],
  }).middleware(EnvironmentAuthenticatedAuth)) {}

`;
  source = replaceOnce(
    source,
    "export class EnvironmentHttpApi extends",
    contracts + "export class EnvironmentHttpApi extends",
  );
  return replaceOnce(
    source,
    ".add(EnvironmentWebhooksHttpApi) {}",
    ".add(EnvironmentWebhooksHttpApi)\n  .add(EnvironmentMobilePushHttpApi) {}",
  );
}

export function configurePushServer(source: string): string {
  if (source.includes('import * as DirectPush from "./notifications/DirectPush.ts";'))
    return source;
  source = replaceOnce(
    source,
    'import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";',
    'import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";\nimport * as DirectPush from "./notifications/DirectPush.ts";',
  );
  source = replaceOnce(
    source,
    "  AgentAwarenessRelay.layer,",
    "  AgentAwarenessRelay.layer,\n  DirectPush.layer,",
  );
  return replaceOnce(
    source,
    "Layer.provide(AuthHttp.layer),",
    "Layer.provide(AuthHttp.layer),\n      Layer.provide(DirectPush.httpLayer),",
  );
}

export function configurePushMobile(source: string, file: string): string {
  switch (file) {
    case "src/App.tsx":
      if (source.includes("<DirectPushCoordinator />")) return source;
      source = replaceOnce(
        source,
        'import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";',
        'import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";\nimport { DirectPushCoordinator } from "./features/agent-awareness/DirectPushCoordinator";',
      );
      return replaceOnce(
        source,
        "<SubscriptionUsageCoordinator />",
        "<SubscriptionUsageCoordinator />\n      <DirectPushCoordinator />",
      );
    case "src/features/agent-awareness/capabilities.ts":
      if (source.includes("export function usesDirectApplePush")) return source;
      return (
        source +
        `
export function usesDirectApplePush() {
  return Platform.OS === "ios" &&
    Constants.expoConfig?.ios?.bundleIdentifier?.startsWith("com.simcity400.") === true;
}
`
      );
    case "src/features/agent-awareness/remoteRegistration.ts":
      if (source.includes("!usesDirectApplePush()")) return source;
      source = replaceOnce(
        source,
        'import { supportsAgentAwarenessPush } from "./capabilities";',
        'import { supportsAgentAwarenessPush, usesDirectApplePush } from "./capabilities";',
      );
      source = replaceOnce(
        source,
        'function canRegisterRemoteLiveActivities(): boolean {\n  return Platform.OS === "ios";',
        'function canRegisterRemoteLiveActivities(): boolean {\n  return !usesDirectApplePush() && Platform.OS === "ios";',
      );
      source = replaceOnce(
        source,
        'function canRegisterPushNotifications(): boolean {\n  return Platform.OS === "ios" || Platform.OS === "android";',
        'function canRegisterPushNotifications(): boolean {\n  return !usesDirectApplePush() && (Platform.OS === "ios" || Platform.OS === "android");',
      );
      return replaceOnce(
        source,
        "  const isExistingIdentity =",
        "  if (usesDirectApplePush()) return;\n  const isExistingIdentity =",
      );
    case "src/features/settings/SettingsNotificationsRouteScreen.tsx":
      if (source.includes("<DirectPushSettings />")) return source;
      source = replaceOnce(
        source,
        'import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";',
        'import { supportsAgentAwarenessPush, usesDirectApplePush } from "../agent-awareness/capabilities";\nimport { DirectPushSettings } from "./DirectPushSettings";',
      );
      return replaceOnce(
        source,
        "export function SettingsNotificationsRouteScreen() {",
        "export function SettingsNotificationsRouteScreen() {\n  if (usesDirectApplePush()) return <DirectPushSettings />;",
      );
    default:
      throw new Error(`Unknown mobile integration: ${file}`);
  }
}

export const MOBILE_PUSH_HOOKS = [
  "src/App.tsx",
  "src/features/agent-awareness/capabilities.ts",
  "src/features/agent-awareness/remoteRegistration.ts",
  "src/features/settings/SettingsNotificationsRouteScreen.tsx",
] as const;

export const PUSH_HOOK_PATHS = [
  "packages/contracts/src/environmentHttp.ts",
  "apps/server/src/server.ts",
  ...MOBILE_PUSH_HOOKS.map((file) => `apps/mobile/${file}`),
] as const;

/** Reapply small integration hooks while allowing upstream application code to keep updating. */
export function configureForkPush(root: string, surface: "mobile" | "server") {
  const replacements: Array<{ path: string; source: string }> = [];
  const prepare = (relative: string, configure: (source: string) => string) => {
    const path = NodePath.join(root, relative);
    replacements.push({
      path,
      source: configure(NodeFS.readFileSync(path, "utf8").replaceAll("\r\n", "\n")),
    });
  };
  prepare("packages/contracts/src/environmentHttp.ts", configurePushContracts);
  if (surface === "server") prepare("apps/server/src/server.ts", configurePushServer);
  else
    for (const file of MOBILE_PUSH_HOOKS)
      prepare(`apps/mobile/${file}`, (source) => configurePushMobile(source, file));
  for (const { path, source } of replacements) NodeFS.writeFileSync(path, source);
}
