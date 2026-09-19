import { describe, expect, it, vi } from "vite-plus/test";
import { configureWindowsUpdateSelection, selectWindowsUpdate } from "./windowsUpdateSelection.ts";

const manifest = (architectures = ["x64", "arm64"]) => ({
  version: "0.0.40-nightly.20260905.1",
  releaseDate: "2026-09-05T00:00:00Z",
  path: "stale-x64.exe",
  sha512: "stale",
  files: architectures.map((arch) => ({
    url: `T3-Code-0.0.40-${arch}.exe`,
    sha512: arch,
    size: 100,
  })),
});

describe("Windows installer architecture", () => {
  it.each(["x64", "arm64"])("selects only %s regardless of manifest ordering", (arch) => {
    for (const order of [
      ["x64", "arm64"],
      ["arm64", "x64"],
    ]) {
      const info = manifest(order);
      selectWindowsUpdate(info, arch);
      expect(info.files).toEqual([{ url: `T3-Code-0.0.40-${arch}.exe`, sha512: arch, size: 100 }]);
    }
  });
  it("refuses an x64-only release on ARM instead of silently replacing the installation", () => {
    const info = manifest(["x64"]);
    expect(() => selectWindowsUpdate(info, "arm64")).toThrow("no Windows arm64 installer");
    expect(info.files[0]?.sha512).toBe("x64");
  });
  it("accepts an unlabelled upstream multi-architecture installer", () => {
    const info = manifest([]);
    info.files = [{ url: "T3-Code-setup.exe", sha512: "universal", size: 200 }];
    selectWindowsUpdate(info, "arm64");
    expect(info.files[0]?.sha512).toBe("universal");
  });
  it("filters during the supported-update check, before metadata can be cached or downloaded", async () => {
    const check = vi.fn(() => true);
    const updater: Parameters<typeof configureWindowsUpdateSelection>[0] = {
      isUpdateSupported: check,
    };
    configureWindowsUpdateSelection(updater, "arm64");
    const info = manifest();
    expect(await updater.isUpdateSupported(info)).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(info.files.map((file) => file.sha512)).toEqual(["arm64"]);
  });
  it("preserves the updater's minimum OS support decision", async () => {
    const updater: Parameters<typeof configureWindowsUpdateSelection>[0] = {
      isUpdateSupported: () => false,
    };
    configureWindowsUpdateSelection(updater, "arm64");
    const info = manifest(["x64"]);
    expect(await updater.isUpdateSupported(info)).toBe(false);
    expect(info.files.map((file) => file.sha512)).toEqual(["x64"]);
  });
});
