// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise the sync against real Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  hasDesktopAssets,
  hasReleaseChanges,
  latestNightly,
  planSync,
  resolveTagCommit,
  syncMain,
  PIPELINE_PATHS,
} from "./fork-sync.ts";

const TAG = "v0.0.39-nightly.20260905.1281";
const pipelineContent = (path: string) =>
  path === ".gitmodules" ? "# personal pipeline\n" : "personal pipeline\n";
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (cwd: string, path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, path), text);
};
const commit = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "fixture");
};

describe("official main sync", () => {
  let directory: string;
  let upstream: string;
  let fork: string;
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-main-sync-"));
    upstream = NodePath.join(directory, "upstream");
    fork = NodePath.join(directory, "fork");
    NodeFS.mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    git(upstream, "config", "core.autocrlf", "false");
    git(upstream, "config", "user.name", "Test");
    git(upstream, "config", "user.email", "test@example.invalid");
    write(upstream, "feature.txt", "base\n");
    write(upstream, ".github/workflows/official.yml", "name: Official\n");
    commit(upstream);
    git(directory, "clone", "-c", "core.autocrlf=false", upstream, fork);
    git(fork, "config", "user.name", "Test");
    git(fork, "config", "user.email", "test@example.invalid");
    git(fork, "rm", ".github/workflows/official.yml");
    for (const path of PIPELINE_PATHS) write(fork, path, pipelineContent(path));
    write(fork, "personal.txt", "discard my feature\n");
    write(fork, "feature.txt", "personal behavior\n");
    write(fork, "fork-upstream.json", '{"commit":"older"}\n');
    commit(fork);
  });
  afterEach(() => {
    if (
      NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(directory).startsWith("t3-main-sync-")
    )
      throw new Error("Unexpected fixture directory");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  it("replaces conflicting fork code and deletes fork features while preserving every pipeline file", () => {
    const original = git(fork, "rev-parse", "HEAD");
    write(upstream, "feature.txt", "official main\n");
    write(upstream, "new.txt", "new upstream feature\n");
    write(upstream, ".github/workflows/new-official.yml", "name: Official\n");
    commit(upstream);
    const official = git(upstream, "rev-parse", "HEAD");
    const synced = syncMain(fork, upstream, official);
    expect(NodeFS.readFileSync(NodePath.join(fork, "feature.txt"), "utf8")).toBe("official main\n");
    expect(NodeFS.existsSync(NodePath.join(fork, "personal.txt"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(fork, "new.txt"), "utf8")).toBe(
      "new upstream feature\n",
    );
    for (const path of PIPELINE_PATHS)
      expect(NodeFS.readFileSync(NodePath.join(fork, path), "utf8")).toBe(pipelineContent(path));
    expect(git(fork, "diff", "--name-only", original, "HEAD", "--", ".github/workflows")).toBe("");
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(fork, "fork-upstream.json"), "utf8")),
    ).toEqual({ repository: "pingdotgg/t3code", branch: "main", commit: official });
    expect(git(fork, "rev-list", "--parents", "-1", "HEAD")).toBe(
      `${synced} ${original} ${official}`,
    );
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(syncMain(fork, upstream, official)).toBe(synced);
  });
  it("keeps vendored submodule metadata usable by sparse checkout credential cleanup after syncing", () => {
    const modules = NodeFS.readFileSync(new URL("../.gitmodules", import.meta.url), "utf8");
    write(fork, ".gitmodules", modules);
    commit(fork);
    const gitlink = git(upstream, "rev-parse", "HEAD");
    for (const name of ["distilled", "floci"])
      git(
        upstream,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${gitlink},.repos/alchemy-effect/submodules/${name}`,
      );
    git(upstream, "commit", "-m", "vendored submodules without root metadata");
    const official = git(upstream, "rev-parse", "HEAD");
    const sparse = NodePath.join(directory, "sparse");
    git(directory, "clone", "--no-checkout", upstream, sparse);
    git(sparse, "sparse-checkout", "set", "--no-cone", "/*", "!/.repos/");
    git(sparse, "checkout", "main");
    expect(() =>
      git(sparse, "submodule", "foreach", "--recursive", "git status --porcelain"),
    ).toThrow("No url found for submodule path");

    syncMain(fork, upstream, official);
    expect(NodeFS.readFileSync(NodePath.join(fork, ".gitmodules"), "utf8")).toBe(modules);
    git(sparse, "fetch", fork, "main");
    git(sparse, "checkout", "--detach", "FETCH_HEAD");
    expect(NodeFS.existsSync(NodePath.join(sparse, ".repos"))).toBe(false);
    expect(git(sparse, "submodule", "foreach", "--recursive", "git status --porcelain")).toBe("");
    expect(git(sparse, "submodule", "status")).toContain(
      ".repos/alchemy-effect/submodules/distilled",
    );
    expect(git(sparse, "submodule", "status")).toContain(".repos/alchemy-effect/submodules/floci");
  });
  it("refuses an upstream commit that moved after checking, without changing the fork", () => {
    const checked = git(upstream, "rev-parse", "HEAD");
    const original = git(fork, "rev-parse", "HEAD");
    write(upstream, "feature.txt", "advanced\n");
    commit(upstream);
    expect(() => syncMain(fork, upstream, checked)).toThrow("moved");
    expect(git(fork, "rev-parse", "HEAD")).toBe(original);
    expect(git(fork, "status", "--porcelain")).toBe("");
  });
  it("refuses uncommitted work or an invalid commit", () => {
    expect(() => syncMain(fork, upstream, "invalid")).toThrow("Invalid official main commit");
    write(fork, "personal.txt", "unsaved\n");
    expect(() => syncMain(fork, upstream, git(upstream, "rev-parse", "HEAD"))).toThrow(
      "clean checkout",
    );
  });
  it("resolves lightweight and annotated release tags and detects unpublished changes", () => {
    const published = git(fork, "rev-parse", "HEAD");
    git(fork, "tag", TAG);
    expect(resolveTagCommit(fork, TAG)).toBe(published);
    git(fork, "tag", "-d", TAG);
    git(fork, "tag", "-a", "-m", "annotated", TAG);
    expect(resolveTagCommit(fork, TAG)).toBe(published);
    write(fork, "docs/notes.md", "docs\n");
    commit(fork);
    expect(hasReleaseChanges(fork, published, git(fork, "rev-parse", "HEAD"))).toBe(false);
    write(fork, "feature.txt", "updated\n");
    commit(fork);
    expect(hasReleaseChanges(fork, published, git(fork, "rev-parse", "HEAD"))).toBe(true);
    expect(resolveTagCommit(fork, TAG + "-missing")).toBeNull();
  });
});

it("uses the newest published nightly and excludes drafts, stable releases and unrelated tags", () => {
  const release = {
    tag_name: TAG,
    prerelease: true,
    draft: false,
    published_at: "2026-09-05T00:00:00Z",
    target_commitish: "abc",
  };
  expect(
    latestNightly([
      { ...release, tag_name: "v1.0.0", prerelease: false, published_at: "2026-09-06T00:00:00Z" },
      { ...release, tag_name: "v0.0.39-nightly.20260905.1282", draft: true },
      release,
    ]),
  ).toEqual(release);
  expect(() => latestNightly([])).toThrow("No published official nightly");
});
it("retries missing publication independently from nightly integration", () => {
  expect(planSync(TAG, TAG, true)).toEqual({ sync: false, release: true });
  expect(planSync(TAG, TAG, false)).toEqual({ sync: false, release: false });
  expect(planSync(TAG, "older", false)).toEqual({ sync: true, release: true });
});
it("requires both installers, both blockmaps and both manifests before a release is complete", () => {
  const prefix = "T3-Code-" + TAG.slice(1);
  const assets = [
    "latest.yml",
    "nightly.yml",
    prefix + "-x64.exe",
    prefix + "-arm64.exe",
    prefix + "-x64.exe.blockmap",
    prefix + "-arm64.exe.blockmap",
  ].map((name) => ({ name, size: 100 }));
  expect(hasDesktopAssets({ tag_name: TAG, assets })).toBe(true);
  for (const missing of assets)
    expect(hasDesktopAssets({ tag_name: TAG, assets: assets.filter((a) => a !== missing) })).toBe(
      false,
    );
  expect(hasDesktopAssets({ tag_name: TAG, assets: assets.map((a) => ({ ...a, size: 0 })) })).toBe(
    false,
  );
  expect(hasDesktopAssets({ tag_name: TAG })).toBe(false);
});
