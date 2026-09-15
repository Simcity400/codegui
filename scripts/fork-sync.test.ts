// @effect-diagnostics nodeBuiltinImport:off - Integration fixtures exercise real Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  hasDesktopAssets,
  hasReleaseChanges,
  latestNightly,
  markSyncBlocked,
  NightlyMergeConflict,
  planSync,
  resolveTagCommit,
  SYNC_BLOCKED_BRANCH,
  SYNC_BLOCKED_FILE,
  syncNightly,
} from "./fork-sync.ts";

const TAG = "v0.0.39-nightly.20260905.1281";
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

describe("published nightly sync", () => {
  let directory: string;
  let upstream: string;
  let fork: string;
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nightly-sync-"));
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
    git(fork, "config", "core.autocrlf", "false");
    git(fork, "config", "user.name", "Test");
    git(fork, "config", "user.email", "test@example.invalid");
    git(fork, "rm", ".github/workflows/official.yml");
    write(fork, ".github/workflows/fork-release.yml", "name: Personal\n");
    write(fork, ".github/workflows/fork-checks.yml", "name: Fork Checks\n");
    write(fork, "personal.txt", "preserve my feature\n");
    write(fork, "fork-upstream.json", '{"tag":"older"}\n');
    commit(fork);
  });
  afterEach(() => {
    const target = NodePath.resolve(directory);
    if (
      NodePath.dirname(target) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(target).startsWith("t3-nightly-sync-")
    )
      throw new Error("Unexpected fixture directory");
    NodeFS.rmSync(target, { recursive: true, force: true });
  });

  it("loads in a clean checkout before dependencies are installed", () => {
    const bootstrap = NodePath.join(directory, "fork-sync.mts");
    NodeFS.copyFileSync(new URL("./fork-sync.ts", import.meta.url), bootstrap);
    const result = NodeChildProcess.spawnSync(process.execPath, [bootstrap, "unknown"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "example/fork" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected check, merge, mark-blocked or verify-release.");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("merges the published tag while preserving fork features and excluding unreleased main", () => {
    write(upstream, "feature.txt", "published\n");
    write(upstream, ".github/workflows/new-official.yml", "name: New upstream job\n");
    commit(upstream);
    git(upstream, "tag", TAG);
    const published = git(upstream, "rev-parse", "HEAD");
    write(upstream, "feature.txt", "unreleased\n");
    commit(upstream);
    const merged = syncNightly(fork, upstream, TAG);
    expect(NodeFS.readFileSync(NodePath.join(fork, "feature.txt"), "utf8")).toBe("published\n");
    expect(NodeFS.readFileSync(NodePath.join(fork, "personal.txt"), "utf8")).toBe(
      "preserve my feature\n",
    );
    expect(git(fork, "ls-files", ".github/workflows").split("\n")).toEqual([
      ".github/workflows/fork-checks.yml",
      ".github/workflows/fork-release.yml",
    ]);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(fork, "fork-upstream.json"), "utf8")),
    ).toEqual({
      tag: TAG,
      commit: published,
    });
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(syncNightly(fork, upstream, TAG)).toBe(merged);
  });
  it("aborts a real code conflict without discarding either side or advancing the marker", () => {
    write(fork, "feature.txt", "personal behavior\n");
    commit(fork);
    const original = git(fork, "rev-parse", "HEAD");
    write(upstream, "feature.txt", "changed upstream behavior\n");
    commit(upstream);
    git(upstream, "tag", TAG);
    let conflict: unknown;
    try {
      syncNightly(fork, upstream, TAG);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(NightlyMergeConflict);
    expect((conflict as NightlyMergeConflict).conflicts).toEqual(["feature.txt"]);
    expect(git(fork, "rev-parse", "HEAD")).toBe(original);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(fork, "fork-upstream.json"), "utf8")).toContain(
      "older",
    );
  });
  it("publishes the blocked marker on origin and leaves the checkout where it was", () => {
    const main = git(fork, "rev-parse", "HEAD");
    const status = {
      repository: "Simcity400/t3code-personal",
      tag: TAG,
      commit: "0123456789abcdef0123456789abcdef01234567",
      conflicts: ["feature.txt"],
      reason: null,
      runUrl: "https://example.invalid/run/1",
      at: "2026-09-06T00:00:00.000Z",
    };
    const marker = markSyncBlocked(fork, status);
    expect(git(fork, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(fork, "rev-parse", "HEAD")).toBe(main);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(git(upstream, "rev-parse", SYNC_BLOCKED_BRANCH)).toBe(marker);
    expect(git(upstream, "rev-parse", `${SYNC_BLOCKED_BRANCH}^`)).toBe(main);
    expect(
      JSON.parse(git(upstream, "show", `${SYNC_BLOCKED_BRANCH}:${SYNC_BLOCKED_FILE}`)),
    ).toEqual(status);
    // A later stop replaces the marker instead of stacking on it.
    const replaced = markSyncBlocked(fork, { ...status, conflicts: [] });
    expect(git(upstream, "rev-parse", SYNC_BLOCKED_BRANCH)).toBe(replaced);
    expect(git(upstream, "rev-parse", `${SYNC_BLOCKED_BRANCH}^`)).toBe(main);
  });
  it("resolves a lightweight or annotated tag to its commit", () => {
    write(upstream, "feature.txt", "tagged\n");
    commit(upstream);
    const head = git(upstream, "rev-parse", "HEAD");
    git(upstream, "tag", TAG);
    expect(resolveTagCommit(upstream, TAG)).toBe(head);
    git(upstream, "tag", "-d", TAG);
    git(upstream, "tag", "-a", "-m", "annotated", TAG);
    expect(resolveTagCommit(upstream, TAG)).toBe(head);
    expect(resolveTagCommit(upstream, "v0.0.39-nightly.20260905.9999")).toBeNull();
  });
  it("does not overwrite a fork-owned workflow", () => {
    write(upstream, ".github/workflows/fork-release.yml", "name: Collision\n");
    commit(upstream);
    git(upstream, "tag", TAG);
    expect(() => syncNightly(fork, upstream, TAG)).toThrow("fork-release.yml");
    expect(
      NodeFS.readFileSync(NodePath.join(fork, ".github/workflows/fork-release.yml"), "utf8"),
    ).toBe("name: Personal\n");
  });
  it("skips documentation-only recovery but includes code and workflow changes", () => {
    const published = git(fork, "rev-parse", "HEAD");
    write(fork, "docs/notes.md", "Documentation update\n");
    commit(fork);
    expect(hasReleaseChanges(fork, published, git(fork, "rev-parse", "HEAD"))).toBe(false);
    write(fork, ".github/workflows/fork-release.yml", "name: Changed pipeline\n");
    commit(fork);
    expect(hasReleaseChanges(fork, published, git(fork, "rev-parse", "HEAD"))).toBe(true);
    expect(hasReleaseChanges(fork, undefined, git(fork, "rev-parse", "HEAD"))).toBe(true);
  });
  it("refuses to operate on uncommitted work", () => {
    write(fork, "personal.txt", "unsaved work\n");
    expect(() => syncNightly(fork, upstream, TAG)).toThrow("clean checkout");
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
