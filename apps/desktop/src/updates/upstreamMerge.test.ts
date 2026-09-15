import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { fetchUpstreamMergeStatus, isSameUpstreamMergeStatus } from "./upstreamMerge.ts";

const feed = { owner: "example", repo: "personal" };
const blocked = {
  repository: "example/personal",
  tag: "v0.0.41-nightly.20260915.1735",
  commit: "b5b29e7b8b12",
  conflicts: ["apps/web/src/components/Sidebar.tsx"],
  reason: null,
  runUrl: "https://github.com/example/personal/actions/runs/1",
  at: "2026-09-15T00:00:00.000Z",
};

describe("public fork sync status", () => {
  it.effect("reads blocked merge details without a private-feed token", () =>
    Effect.gen(function* () {
      const fetchImpl: typeof fetch = async (url, options) => {
        expect(String(url)).toBe(
          "https://api.github.com/repos/example/personal/contents/fork-sync-status.json?ref=needs-merge-help",
        );
        expect(new Headers(options?.headers).has("Authorization")).toBe(false);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return Response.json(blocked);
      };
      expect(yield* fetchUpstreamMergeStatus(feed, fetchImpl)).toEqual(blocked);
    }),
  );
  it.effect("clears the notice when a successful merge removed its marker", () =>
    Effect.gen(function* () {
      expect(
        yield* fetchUpstreamMergeStatus(feed, async () => new Response(null, { status: 404 })),
      ).toBeNull();
    }),
  );
  for (const response of [
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 500 }),
    () => Response.json({ malformed: true }),
    () => Response.json({ ...blocked, repository: "different/repo" }),
  ]) {
    it.effect("preserves the previous warning when status cannot be verified", () =>
      Effect.gen(function* () {
        const result = yield* fetchUpstreamMergeStatus(feed, async () => response()).pipe(
          Effect.orElseSucceed(() => blocked),
        );
        expect(result).toEqual(blocked);
      }),
    );
  }
  it("does not broadcast repeated identical status", () => {
    expect(
      isSameUpstreamMergeStatus(blocked, { ...blocked, conflicts: [...blocked.conflicts] }),
    ).toBe(true);
    expect(isSameUpstreamMergeStatus(blocked, null)).toBe(false);
    expect(isSameUpstreamMergeStatus(blocked, { ...blocked, tag: "newer" })).toBe(false);
  });
});
