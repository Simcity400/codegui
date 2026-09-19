import type { AppUpdater } from "electron-updater";

type UpdateInfo = Parameters<AppUpdater["isUpdateSupported"]>[0];

/** Select before update discovery caches the manifest or starts a download. */
export function selectWindowsUpdate(info: UpdateInfo, arch: string): void {
  const installers = info.files.filter((file) => /\.exe(?:$|[?#])/i.test(file.url));
  const suffix = `-${arch}.exe`;
  const matching = installers.find((file) =>
    file.url.split(/[?#]/, 1)[0]?.toLowerCase().endsWith(suffix),
  );
  // An unlabelled single installer can be an upstream multi-architecture NSIS
  // bundle. Explicitly labelled installers must never cross architectures.
  const selected =
    matching ??
    (installers.length === 1 && !/-(?:x64|arm64|ia32)\.exe(?:$|[?#])/i.test(installers[0]!.url)
      ? installers[0]
      : undefined);
  if (!selected)
    throw new Error(
      `This release has no Windows ${arch} installer. Your current installation has not changed.`,
    );
  info.files.splice(0, info.files.length, selected);
}

export function configureWindowsUpdateSelection(
  updater: Pick<AppUpdater, "isUpdateSupported">,
  arch: string,
): void {
  const isSupported = updater.isUpdateSupported.bind(updater);
  updater.isUpdateSupported = async (info) => {
    if (!(await isSupported(info))) return false;
    selectWindowsUpdate(info, arch);
    return true;
  };
}
