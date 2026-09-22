// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone CI script against a local Git remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { pinReleaseTag } from "./pin-release-tag.ts";

const transient = () => new Error("remote: fatal error in commit_refs");
function fixture() {
  const refs: { main: string | undefined; tag: string | undefined } = {
    main: "source",
    tag: undefined,
  };
  return {
    refs,
    readRefs: vi.fn(() => ({ ...refs })),
    pushTag: vi.fn(() => {
      refs.tag = "source";
    }),
    wait: vi.fn(async (_milliseconds: number) => {}),
    retry: vi.fn(),
  };
}

it("retries a transient rejected push and verifies the eventual tag", async () => {
  const remote = fixture();
  remote.pushTag.mockImplementationOnce(() => {
    throw transient();
  });
  await expect(pinReleaseTag("source", remote)).resolves.toBe(true);
  expect(remote.pushTag).toHaveBeenCalledTimes(2);
  expect(remote.refs.tag).toBe("source");
  expect(remote.wait).toHaveBeenCalledTimes(1);
});

it("accepts a successful push whose response was lost without pushing again", async () => {
  const remote = fixture();
  remote.pushTag.mockImplementationOnce(() => {
    remote.refs.tag = "source";
    throw new Error("Connection reset by peer");
  });
  await expect(pinReleaseTag("source", remote)).resolves.toBe(true);
  expect(remote.pushTag).toHaveBeenCalledTimes(1);
  expect(remote.wait).not.toHaveBeenCalled();
});

it("reuses a matching reserved tag even after main advances", async () => {
  const remote = fixture();
  remote.refs.main = "newer";
  remote.refs.tag = "source";
  await expect(pinReleaseTag("source", remote)).resolves.toBe(true);
  expect(remote.pushTag).not.toHaveBeenCalled();
});

it.each([false, true])(
  "refuses a tag naming different source (after push: %s)",
  async (afterPush) => {
    const remote = fixture();
    if (afterPush)
      remote.pushTag.mockImplementationOnce(() => {
        remote.refs.tag = "other";
      });
    else remote.refs.tag = "other";
    await expect(pinReleaseTag("source", remote)).rejects.toThrow("different source");
    expect(remote.wait).not.toHaveBeenCalled();
    expect(remote.refs.tag).toBe("other");
  },
);

it("skips a superseded source before retrying tag creation", async () => {
  const remote = fixture();
  remote.pushTag.mockImplementationOnce(() => {
    throw transient();
  });
  remote.wait.mockImplementationOnce(async () => {
    remote.refs.main = "newer";
  });
  await expect(pinReleaseTag("source", remote)).resolves.toBe(false);
  expect(remote.pushTag).toHaveBeenCalledTimes(1);
  expect(remote.refs.tag).toBeUndefined();
});

it("does not mistake a remote lookup failure for a missing tag", async () => {
  const remote = fixture();
  remote.readRefs.mockImplementationOnce(() => {
    throw new Error("Could not resolve host: github.com");
  });
  await expect(pinReleaseTag("source", remote)).resolves.toBe(true);
  expect(remote.wait).toHaveBeenCalledTimes(1);
  expect(remote.pushTag).toHaveBeenCalledTimes(1);
});

it("fails immediately on permission errors", async () => {
  const remote = fixture();
  remote.pushTag.mockImplementation(() => {
    throw new Error("403 Resource not accessible by integration");
  });
  await expect(pinReleaseTag("source", remote)).rejects.toThrow("403");
  expect(remote.pushTag).toHaveBeenCalledTimes(1);
  expect(remote.wait).not.toHaveBeenCalled();
});

it("limits retries when GitHub keeps rejecting writes", async () => {
  const remote = fixture();
  remote.pushTag.mockImplementation(() => {
    throw transient();
  });
  await expect(pinReleaseTag("source", remote)).rejects.toThrow("commit_refs");
  expect(remote.pushTag).toHaveBeenCalledTimes(4);
  expect(remote.wait).toHaveBeenCalledTimes(3);
});

it("runs without dependencies and reserves the exact checked-out commit", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pin-release-"));
  const cleanup = () => {
    const resolved = NodePath.resolve(root);
    if (
      NodePath.dirname(resolved) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(resolved).startsWith("t3-pin-release-")
    )
      throw new Error("Unexpected fixture directory");
    NodeFS.rmSync(resolved, { recursive: true, force: true });
  };
  try {
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-m", "source");
    git("init", "--bare", "remote.git");
    git("remote", "add", "origin", NodePath.join(root, "remote.git"));
    git("push", "origin", "main");
    const source = git("rev-parse", "HEAD");
    const tag = "v0.0.43-nightly.20260922.12345";
    const script = NodePath.join(root, "pin-release-tag.mts");
    const output = NodePath.join(root, "github-output");
    NodeFS.copyFileSync(new URL("./pin-release-tag.ts", import.meta.url), script);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      NodeChildProcess.execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
      });
    }
    expect(git("ls-remote", "origin", `refs/tags/${tag}`)).toBe(`${source}\trefs/tags/${tag}`);
    expect(NodeFS.readFileSync(output, "utf8")).toBe("ready=true\nready=true\n");
  } finally {
    cleanup();
  }
});
