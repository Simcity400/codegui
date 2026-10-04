// @effect-diagnostics nodeBuiltinImport:off - Build configuration fixtures come from the upstream-owned sources.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { configureDesktop, configureMobile } from "./configure-fork-build.ts";

describe("personal build configuration", () => {
  it("uses the existing mobile signing and update destinations without changing upstream features", () => {
    const source = NodeFS.readFileSync(
      new URL("../apps/mobile/app.config.ts", import.meta.url),
      "utf8",
    );
    const configured = configureMobile(source);
    expect(configured).toContain('iosBundleIdentifier: "com.simcity400.t3code.preview"');
    expect(configured).toContain('appleTeamId: "X8R35QF7WN"');
    expect(configured).toContain("https://u.expo.dev/1ea2f814-b9d5-48ab-b427-19b4e3d384b1");
    expect(configured).toContain('projectId: "1ea2f814-b9d5-48ab-b427-19b4e3d384b1"');
    expect(configured).toContain('owner: "simcity400"');
    expect(
      configured
        .replaceAll("com.simcity400.t3code", "com.t3tools.t3code")
        .replaceAll("1ea2f814-b9d5-48ab-b427-19b4e3d384b1", "d763fcb8-d37c-41ea-a773-b54a0ab4a454")
        .replace('appleTeamId: "X8R35QF7WN"', 'appleTeamId: "ARK85ZXQ4Z"')
        .replace('owner: "simcity400"', 'owner: "pingdotgg"'),
    ).toBe(source);
  });
  it("configures Windows selection before the updater discovers an update", () => {
    const source = NodeFS.readFileSync(
      new URL("../apps/desktop/src/electron/ElectronUpdater.ts", import.meta.url),
      "utf8",
    );
    const configured = configureDesktop(source);
    expect(configured.indexOf("configureWindowsUpdateSelection(autoUpdater,")).toBeLessThan(
      configured.indexOf("return autoUpdater.checkForUpdates();"),
    );
    expect(configured).toContain('app.runningUnderARM64Translation ? "arm64" : process.arch');
  });
  it("stops instead of publishing to the official account when upstream config changes", () => {
    expect(() => configureMobile("changed upstream configuration")).toThrow(
      "Official build configuration changed",
    );
    expect(() => configureDesktop("changed upstream updater")).toThrow(
      "Official build configuration changed",
    );
  });
});
