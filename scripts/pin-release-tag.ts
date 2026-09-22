// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI release bootstrap.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";

interface ReleaseRefs {
  readonly main: string | undefined;
  readonly tag: string | undefined;
}

interface ReleaseTagRemote {
  readonly readRefs: () => ReleaseRefs;
  readonly pushTag: () => void;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly retry: (error: unknown, attempt: number) => void;
}

function isTransientGitFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /fatal error in commit_refs|remote end hung up|connection (?:reset|timed out)|could not resolve host|requested URL returned error: 5\d\d|HTTP (?:5\d\d|2 stream .*not closed cleanly)|TLS connection was non-properly terminated/i.test(
      error.message,
    )
  );
}

/** Reserve one immutable source tag; retries also handle a lost successful push response. */
export async function pinReleaseTag(source: string, remote: ReleaseTagRemote): Promise<boolean> {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const existing = remote.readRefs();
      if (existing.tag !== undefined) {
        if (existing.tag !== source) throw new Error("Release tag names different source");
        return true;
      }
      if (existing.main === undefined) throw new Error("Remote main is missing");
      // GITHUB_TOKEN may refuse new tags on older workflow-changing commits.
      // Reserve while this source is main; an existing matching tag is safe to reuse.
      if (existing.main !== source) return false;
      let pushError: unknown;
      try {
        remote.pushTag();
      } catch (error) {
        pushError = error;
      }
      const pushed = remote.readRefs();
      if (pushed.tag !== undefined) {
        if (pushed.tag !== source) throw new Error("Release tag names different source");
        return true;
      }
      if (pushError !== undefined) throw pushError;
      throw new Error("Release tag was not visible after a successful push");
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransientGitFailure(error)) throw error;
      remote.retry(error, attempt + 1);
      await remote.wait(delay);
    }
  }
}

if (import.meta.main) {
  const tag = process.env.RELEASE_TAG;
  const output = process.env.GITHUB_OUTPUT;
  if (!tag || !/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag))
    throw new Error("Invalid release tag");
  if (!output) throw new Error("Missing GITHUB_OUTPUT");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const source = git("rev-parse", "HEAD");
  const ready = await pinReleaseTag(source, {
    readRefs: () => {
      const refs = new Map(
        git("ls-remote", "origin", "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [sha, ref] = line.split(/\s+/);
            return [ref, sha] as const;
          }),
      );
      return {
        main: refs.get("refs/heads/main"),
        tag: refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`),
      };
    },
    pushTag: () => {
      git("push", "origin", `${source}:refs/tags/${tag}`);
    },
    wait: NodeTimersPromises.setTimeout,
    retry: (error, attempt) => console.warn(`Tag reservation retry ${attempt}: ${String(error)}`),
  });
  if (!ready) console.log("A newer main is queued for release; skipping this superseded build.");
  NodeFS.appendFileSync(output, `ready=${ready}\n`);
}
