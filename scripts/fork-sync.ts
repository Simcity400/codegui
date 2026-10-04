// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - CI bootstrap runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface Release {
  tag_name: string;
  target_commitish: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets?: ReadonlyArray<{ name: string; size: number }>;
}
const nightlyTag = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
export const PIPELINE_PATHS = [
  ".github/workflows/fork-sync.yml",
  ".github/workflows/fork-release.yml",
  ".github/workflows/fork-mobile-preview.yml",
  ".github/workflows/fork-checks.yml",
  ".gitleaks.toml",
  "scripts/fork-sync.ts",
  "scripts/fork-sync.test.ts",
  "scripts/pin-release-tag.ts",
  "scripts/pin-release-tag.test.ts",
  "scripts/mobile-build-budget.ts",
  "scripts/mobile-build-budget.test.ts",
  "scripts/configure-fork-build.ts",
  "scripts/configure-fork-build.test.ts",
  "scripts/fork-windows-update-selection.ts",
  "scripts/fork-windows-update-selection.test.ts",
] as const;

export function latestNightly(releases: ReadonlyArray<Release>): Release {
  const release = releases
    .filter((r) => !r.draft && r.prerelease && nightlyTag.test(r.tag_name))
    .toSorted((a, b) => b.published_at.localeCompare(a.published_at))[0];
  if (!release) throw new Error("No published official nightly was found.");
  return release;
}

export function hasDesktopAssets(release: Pick<Release, "tag_name" | "assets">): boolean {
  if (!nightlyTag.test(release.tag_name)) return false;
  const prefix = "T3-Code-" + release.tag_name.slice(1);
  const required = [
    "latest.yml",
    "nightly.yml",
    ...["x64", "arm64"].flatMap((arch) => [
      prefix + "-" + arch + ".exe",
      prefix + "-" + arch + ".exe.blockmap",
    ]),
  ];
  return required.every((name) =>
    release.assets?.some((asset) => asset.name === name && asset.size > 0),
  );
}

export function planSync(commit: string, trackedCommit: string, releaseNeeded: boolean) {
  const sync = commit !== trackedCommit;
  return { sync, release: sync || releaseNeeded };
}

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Match the release workflow's Markdown-only exclusion, including recovery. */
export function hasReleaseChanges(
  cwd: string,
  published: string | undefined,
  main: string,
): boolean {
  if (!published || !/^[a-f0-9]{40}$/.test(published)) return true;
  if (published === main) return false;
  const available = NodeChildProcess.spawnSync("git", ["cat-file", "-e", published + "^{commit}"], {
    cwd,
    stdio: "ignore",
  });
  if (available.status !== 0) git(cwd, "fetch", "--no-tags", "--depth=1", "origin", published);
  return git(cwd, "diff", "--name-only", "-z", published, main)
    .split("\0")
    .some((path) => path !== "" && !path.endsWith(".md"));
}

/** Replace application code with official main, retaining only the build and publish pipeline. */
export function syncMain(cwd: string, upstream: string, expected: string): string {
  if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error("Invalid official main commit.");
  if (git(cwd, "status", "--porcelain"))
    throw new Error("Upstream sync requires a clean checkout.");
  git(cwd, "fetch", "--no-tags", upstream, "+refs/heads/main:refs/fork-sync/main");
  const commit = git(cwd, "rev-parse", "refs/fork-sync/main");
  if (commit !== expected)
    throw new Error(`Official main moved from ${expected} to ${commit} since it was checked.`);
  const original = git(cwd, "rev-parse", "HEAD");
  const available = PIPELINE_PATHS.filter((path) => git(cwd, "ls-files", "--", path) !== "");
  try {
    // Keep upstream as a parent so Git records every official commit as integrated.
    git(cwd, "merge", "--no-commit", "--no-ff", "--strategy=ours", commit);
    git(cwd, "read-tree", "--reset", "-u", commit);
    const workflows = git(cwd, "ls-files", "-z", ".github/workflows").split("\0").filter(Boolean);
    if (workflows.length) git(cwd, "rm", "-f", "--", ...workflows);
    if (available.length)
      git(cwd, "restore", "--source=" + original, "--staged", "--worktree", "--", ...available);
    // The Actions token cannot push new workflow definitions; those are maintained separately.
    if (git(cwd, "diff", "--cached", "--name-only", original, "--", ".github/workflows"))
      throw new Error("The sync would change fork workflows.");
    NodeFS.writeFileSync(
      NodePath.join(cwd, "fork-upstream.json"),
      JSON.stringify({ repository: "pingdotgg/t3code", branch: "main", commit }, null, 2) + "\n",
    );
    git(cwd, "add", "fork-upstream.json");
    const pendingMerge =
      NodeChildProcess.spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd,
        stdio: "ignore",
      }).status === 0;
    if (pendingMerge || git(cwd, "diff", "--cached", "--name-only"))
      git(cwd, "commit", "-m", `chore(fork): sync official main ${commit.slice(0, 12)}`);
    return git(cwd, "rev-parse", "HEAD");
  } catch (error) {
    NodeChildProcess.spawnSync("git", ["merge", "--abort"], { cwd, stdio: "ignore" });
    git(cwd, "reset", "--hard", original);
    throw error;
  }
}

export function resolveMainCommit(remote: string): string {
  const commit = git(process.cwd(), "ls-remote", remote, "refs/heads/main").split(/\s+/)[0];
  if (!commit || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Could not resolve official main.");
  return commit;
}

/** The commit a tag names; nightlies are lightweight, so prefer the peeled ref when there is one. */
export function resolveTagCommit(remote: string, tag: string): string | null {
  const listed = NodeChildProcess.spawnSync(
    "git",
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8" },
  );
  const lines = (listed.stdout ?? "").trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const commit = (peeled ?? lines[0])?.split(/\s+/)[0];
  return commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null;
}

function output(name: string, value: string | boolean) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("This command requires GITHUB_OUTPUT.");
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (import.meta.main) {
  const cwd = process.cwd();
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Missing fork repository.");
  if (process.argv[2] === "check") {
    const releases = (repository: string): Release[] =>
      JSON.parse(
        NodeChildProcess.execFileSync(
          "gh",
          [
            "api",
            `repos/${repository}/releases?per_page=30`,
            "--jq",
            "[.[] | {tag_name, target_commitish, published_at, prerelease, draft, assets: [.assets[] | {name, size}]}]",
          ],
          {
            encoding: "utf8",
          },
        ),
      );
    const upstream = resolveMainCommit("https://github.com/pingdotgg/t3code.git");
    const tracked = JSON.parse(
      NodeFS.readFileSync(NodePath.join(cwd, "fork-upstream.json"), "utf8"),
    ) as {
      commit: string;
    };
    const published = releases(repo)
      .filter((r) => !r.draft && r.prerelease && nightlyTag.test(r.tag_name))
      .toSorted((a, b) => b.published_at.localeCompare(a.published_at))[0];
    const plan = planSync(
      upstream,
      tracked.commit,
      !published ||
        !hasDesktopAssets(published) ||
        hasReleaseChanges(
          cwd,
          // Release metadata may name a moving branch; only the tag pins the build.
          resolveTagCommit("https://github.com/" + repo + ".git", published.tag_name) ?? undefined,
          git(cwd, "rev-parse", "HEAD"),
        ),
    );
    output("ref", git(cwd, "rev-parse", "HEAD"));
    output("commit", upstream);
    output("sync", plan.sync);
    output("release", plan.release);
    console.log(
      `Official main: ${upstream}; integrated: ${tracked.commit}; sync: ${plan.sync}; publish: ${plan.release}`,
    );
  } else if (process.argv[2] === "merge") {
    output(
      "ref",
      syncMain(cwd, "https://github.com/pingdotgg/t3code.git", process.env.UPSTREAM_COMMIT ?? ""),
    );
  } else if (process.argv[2] === "verify-release") {
    const id = process.env.RELEASE_ID;
    if (!id || !/^\d+$/.test(id)) throw new Error("Missing release ID.");
    const release = JSON.parse(
      NodeChildProcess.execFileSync("gh", ["api", "repos/" + repo + "/releases/" + id], {
        encoding: "utf8",
      }),
    ) as Release;
    if (!hasDesktopAssets(release))
      throw new Error(
        "The draft release is missing a Windows installer, blockmap or update manifest.",
      );
  } else throw new Error("Expected check, merge or verify-release.");
}
