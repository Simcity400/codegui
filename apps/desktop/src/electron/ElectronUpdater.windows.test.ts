import { assert, describe, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import { beforeEach, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  app: { runningUnderARM64Translation: false },
  updater: undefined as NsisUpdater | undefined,
}));
vi.mock("electron", () => ({ app: native.app }));
vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return native.updater;
  },
}));

// Keep real update discovery, caching, provider resolution and NSIS selection.
// Replace only the release fetch and the final transfer; never launch an installer.
class RecordingUpdater extends NsisUpdater {
  readonly transfers: DownloadExecutorTask["fileInfo"][] = [];
  info = {
    version: "2.0.0",
    releaseDate: "2026-09-05T00:00:00Z",
    path: "T3-Code-2.0.0-x64.exe",
    sha512: "x64",
    files: ["x64", "arm64"].map((arch) => ({
      url: `T3-Code-2.0.0-${arch}.exe`,
      sha512: arch,
      size: 100,
    })),
  };
  constructor() {
    super(null, {
      version: "1.0.0",
      name: "test",
      isPackaged: true,
      appUpdateConfigPath: "unused",
      userDataPath: "unused",
      baseCachePath: "unused",
      whenReady: async () => {},
      relaunch: vi.fn(),
      quit: vi.fn(),
      onQuit: vi.fn(),
    });
    this.autoDownload = false;
    this.logger = null;
    this.isUserWithinRollout = () => true;
  }
  protected override async getUpdateInfoAndProvider() {
    return {
      info: this.info,
      provider: new GenericProvider(
        { provider: "generic", url: "https://updates.example.test/" },
        this,
        {
          platform: "win32",
          isUseMultipleRangeRequest: false,
          executor: new ElectronHttpExecutor(),
        },
      ),
    };
  }
  protected override async executeDownload(options: DownloadExecutorTask) {
    this.transfers.push(options.fileInfo);
    return [options.fileInfo.url.href];
  }
}

beforeEach(() => {
  vi.resetModules();
  native.app.runningUnderARM64Translation = false;
});

describe("Windows update downloads", () => {
  for (const scenario of [
    { name: "native ARM", arch: "arm64", translated: false, expected: "arm64" },
    { name: "x64 emulation on ARM", arch: "x64", translated: true, expected: "arm64" },
    { name: "native x64", arch: "x64", translated: false, expected: "x64" },
  ] as const) {
    it.effect(`downloads the native installer on ${scenario.name} across repeated checks`, () =>
      Effect.gen(function* () {
        const updater = new RecordingUpdater();
        native.updater = updater;
        native.app.runningUnderARM64Translation = scenario.translated;
        const { make } = yield* Effect.promise(() => import("./ElectronUpdater.ts"));
        for (const channel of ["latest", "nightly"]) {
          yield* make.setChannel(channel);
          yield* make.checkForUpdates;
          yield* make.downloadUpdate;
        }
        assert.deepEqual(
          updater.transfers.map((file) => [file.url.pathname, file.info.sha512]),
          [
            [`/T3-Code-2.0.0-${scenario.expected}.exe`, scenario.expected],
            [`/T3-Code-2.0.0-${scenario.expected}.exe`, scenario.expected],
          ],
        );
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessArchitecture, scenario.arch),
      ),
    );
  }

  it.effect("refuses an x64-only release on an emulated ARM host before any transfer", () =>
    Effect.gen(function* () {
      const updater = new RecordingUpdater();
      updater.info.files = updater.info.files.filter((file) => file.sha512 === "x64");
      native.updater = updater;
      native.app.runningUnderARM64Translation = true;
      const { make, ElectronUpdaterCheckForUpdatesError } = yield* Effect.promise(
        () => import("./ElectronUpdater.ts"),
      );
      const error = yield* make.checkForUpdates.pipe(Effect.flip);
      assert.instanceOf(error, ElectronUpdaterCheckForUpdatesError);
      assert.instanceOf(error.cause, Error);
      assert.include((error.cause as Error).message, "no Windows arm64 installer");
      assert.deepEqual(updater.transfers, []);
      yield* make.downloadUpdate.pipe(Effect.flip);
      assert.deepEqual(updater.transfers, []);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessArchitecture, "x64"),
    ),
  );
});
