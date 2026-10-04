// @effect-diagnostics nodeBuiltinImport:off - Personal build configuration applied only inside CI checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(`Official build configuration changed; review: ${before}`);
  return source.replace(before, after);
}

/** Keep the checked-in app config upstream-owned while using the existing personal EAS project. */
export function configureMobile(source: string): string {
  for (const suffix of [".dev", ".preview", ""]) {
    for (const field of ["iosBundleIdentifier", "androidPackage"]) {
      source = replaceOnce(
        source,
        `${field}: "com.t3tools.t3code${suffix}"`,
        `${field}: "com.simcity400.t3code${suffix}"`,
      );
    }
  }
  source = replaceOnce(
    source,
    "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    "https://u.expo.dev/1ea2f814-b9d5-48ab-b427-19b4e3d384b1",
  );
  source = replaceOnce(
    source,
    'projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454"',
    'projectId: "1ea2f814-b9d5-48ab-b427-19b4e3d384b1"',
  );
  source = replaceOnce(source, 'appleTeamId: "ARK85ZXQ4Z"', 'appleTeamId: "X8R35QF7WN"');
  return replaceOnce(source, 'owner: "pingdotgg"', 'owner: "simcity400"');
}

/** Personal releases contain separate Windows installers in one update manifest. */
export function configureDesktop(source: string): string {
  source = replaceOnce(
    source,
    'import { autoUpdater } from "electron-updater";',
    'import { autoUpdater } from "electron-updater";\nimport { app } from "electron";\nimport { configureWindowsUpdateSelection } from "../updates/windowsUpdateSelection.ts";\nlet windowsSelectionConfigured = false;',
  );
  return replaceOnce(
    source,
    "try: () => autoUpdater.checkForUpdates(),",
    `try: () => {
        if (process.platform === "win32" && !windowsSelectionConfigured) {
          configureWindowsUpdateSelection(autoUpdater, app.runningUnderARM64Translation ? "arm64" : process.arch);
          windowsSelectionConfigured = true;
        }
        return autoUpdater.checkForUpdates();
      },`,
  );
}

if (import.meta.main) {
  const root = NodePath.resolve(import.meta.dirname, "..");
  if (process.argv[2] === "mobile") {
    const path = NodePath.join(root, "apps/mobile/app.config.ts");
    NodeFS.writeFileSync(path, configureMobile(NodeFS.readFileSync(path, "utf8")));
  } else if (process.argv[2] === "desktop") {
    const path = NodePath.join(root, "apps/desktop/src/electron/ElectronUpdater.ts");
    const source = configureDesktop(NodeFS.readFileSync(path, "utf8"));
    NodeFS.copyFileSync(
      NodePath.join(root, "scripts/fork-windows-update-selection.ts"),
      NodePath.join(root, "apps/desktop/src/updates/windowsUpdateSelection.ts"),
    );
    NodeFS.writeFileSync(path, source);
  } else if (process.argv[2] === "checks") {
    const path = NodePath.join(root, "scripts/build-desktop-artifact.test.ts");
    // Git for Windows tar treats drive-letter paths as remote hosts. Retain the
    // pipeline's portable fixture setup without changing upstream-owned tests.
    const source = replaceOnce(
      NodeFS.readFileSync(path, "utf8"),
      'ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {',
      'ChildProcess.make("tar", ["-czf", path.basename(archivePath), "-C", "content", "."], {\n      cwd: input.root,',
    );
    NodeFS.writeFileSync(path, source);
  } else throw new Error("Expected mobile, desktop or checks.");
}
