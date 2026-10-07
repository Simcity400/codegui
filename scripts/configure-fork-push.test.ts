// @effect-diagnostics nodeBuiltinImport:off - Exercise integration against the actual upstream-owned sources.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  configurePushContracts,
  configurePushMobile,
  configurePushServer,
  MOBILE_PUSH_HOOKS,
} from "./configure-fork-push.ts";

const read = (file: string) =>
  NodeFS.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
describe("personal Apple push integration", () => {
  it("adds authenticated delivery routes and a single server worker", () => {
    const contracts = configurePushContracts(read("packages/contracts/src/environmentHttp.ts"));
    expect(contracts).toContain(".add(EnvironmentMobilePushHttpApi)");
    expect(
      contracts.match(/middleware\(EnvironmentAuthenticatedAuth\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(configurePushContracts(contracts)).toBe(contracts);
    const server = configurePushServer(read("apps/server/src/server.ts"));
    expect(server.match(/DirectPush.layer,/g)).toHaveLength(1);
    expect(server).toContain("Layer.provide(DirectPush.httpLayer)");
    expect(configurePushServer(server)).toBe(server);
  });
  it("uses direct delivery only in personal iPhone builds and mounts its settings and coordinator", () => {
    const configured = new Map(
      MOBILE_PUSH_HOOKS.map((file) => {
        const source = configurePushMobile(read(`apps/mobile/${file}`), file);
        expect(configurePushMobile(source, file)).toBe(source);
        return [file, source];
      }),
    );
    expect(configured.get("src/App.tsx")).toContain("<DirectPushCoordinator />");
    expect(configured.get("src/features/settings/SettingsNotificationsRouteScreen.tsx")).toContain(
      "if (usesDirectApplePush()) return <DirectPushSettings />",
    );
    expect(configured.get("src/features/agent-awareness/remoteRegistration.ts")).toContain(
      '!usesDirectApplePush() && (Platform.OS === "ios" || Platform.OS === "android")',
    );
    expect(configured.get("src/features/agent-awareness/capabilities.ts")).toContain(
      'startsWith("com.simcity400.")',
    );
  });
  it("stops publishing when an upstream integration point moves", () => {
    expect(() => configurePushContracts("changed contract")).toThrow("changed upstream");
    expect(() => configurePushServer("changed server")).toThrow("changed upstream");
    expect(() => configurePushMobile("changed app", "src/App.tsx")).toThrow("changed upstream");
  });
});
