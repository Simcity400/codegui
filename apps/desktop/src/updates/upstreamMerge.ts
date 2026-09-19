import {
  type DesktopUpstreamMergeStatus,
  DesktopUpstreamMergeStatusSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Fork Sync publishes this file on the `needs-merge-help` branch when a
// nightly cannot be merged on its own (scripts/fork-sync.ts markSyncBlocked)
// and deletes the branch once a resolved main is pushed.
export const UPSTREAM_MERGE_STATUS_BRANCH = "needs-merge-help";
export const UPSTREAM_MERGE_STATUS_FILE = "fork-sync-status.json";

const decodeStatus = Schema.decodeUnknownEffect(DesktopUpstreamMergeStatusSchema);

/** Structural compare so a repeated read does not re-broadcast an unchanged notice. */
export function isSameUpstreamMergeStatus(
  left: DesktopUpstreamMergeStatus | null,
  right: DesktopUpstreamMergeStatus | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.tag === right.tag &&
    left.commit === right.commit &&
    left.reason === right.reason &&
    left.runUrl === right.runUrl &&
    left.at === right.at &&
    left.conflicts.length === right.conflicts.length &&
    left.conflicts.every((path, index) => path === right.conflicts[index])
  );
}

export function upstreamMergeStatusUrl(feed: { readonly owner: string; readonly repo: string }) {
  return `https://api.github.com/repos/${feed.owner}/${feed.repo}/contents/${UPSTREAM_MERGE_STATUS_FILE}?ref=${UPSTREAM_MERGE_STATUS_BRANCH}`;
}

export class UpstreamMergeStatusError extends Schema.TaggedError<UpstreamMergeStatusError>()(
  "UpstreamMergeStatusError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Read a public fork's marker; only a missing marker clears a known blockage. */
export const fetchUpstreamMergeStatus = (
  feed: { readonly owner: string; readonly repo: string },
  fetchImpl: typeof fetch = fetch,
) =>
  Effect.tryPromise({
    try: (signal) =>
      fetchImpl(upstreamMergeStatusUrl(feed), {
        signal,
        headers: { Accept: "application/vnd.github.raw+json" },
      }),
    catch: (cause) =>
      new UpstreamMergeStatusError({ message: "Could not read the upstream sync status", cause }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.succeed(null);
      if (!response.ok)
        return Effect.fail(
          new UpstreamMergeStatusError({
            message: `Upstream status request failed: ${response.status}`,
          }),
        );
      return Effect.tryPromise(() => response.json() as Promise<unknown>).pipe(
        Effect.flatMap(decodeStatus),
        Effect.filterOrFail(
          (status) => status.repository === `${feed.owner}/${feed.repo}`,
          () =>
            new UpstreamMergeStatusError({
              message: "Upstream status belongs to a different repository",
            }),
        ),
      );
    }),
  );
