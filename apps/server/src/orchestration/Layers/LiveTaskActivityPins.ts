import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

// Newest live tasks whose lifecycle rows every thread-detail page carries,
// matching the client roster cap.
const PINNED_LIVE_TASK_LIMIT = 100;

const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["stopped", "interrupted", "error"]);

export const PinnedActivityLookupInput = Schema.Struct({
  threadId: ThreadId,
  includeLiveTasks: Schema.Boolean,
});

/**
 * Extends ProjectionSnapshotQuery's pinned activity CTE. Beyond blocking
 * requests, the newest session boundary is always pinned, and task rows for
 * work that is still running are pinned the same way so the Agents surface
 * shows every live subagent and background task on the first page, however
 * many turns ago it was launched (settled and idle tasks load with their
 * turn's page). Bounded by the newest PINNED_LIVE_TASK_LIMIT live tasks times
 * their handful of lifecycle rows; includeLiveTasks comes from
 * shouldPinLiveTasks.
 */
export const makeLiveTaskActivityPins = <E>(deps: {
  readonly sql: SqlClient.SqlClient;
  readonly getThreadSessionRowByThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<{ readonly status: string }>, E>;
  readonly toPersistenceSqlOrDecodeError: (
    sqlOperation: string,
    decodeOperation: string,
  ) => (cause: unknown) => ProjectionRepositoryError;
}) => {
  const { sql } = deps;

  // Live-task pinning is a generous superset of what the client fold calls
  // live (the client alone decides the status it shows; an extra pinned row
  // costs bytes, never correctness): only status-bearing rows vote —
  // task.started opens, task.completed and status-carrying task.updated close
  // — because the stable-id progress/usage upserts keep landing after a task
  // settled and would otherwise read as "still running" forever. Ties on
  // equal keys prefer the settled vote. Members of a live workflow ride along
  // through parentAgentId since their lifecycle is progress-only. Newest live
  // tasks first, capped.
  const liveTaskPinCtes = (threadId: string) => sql`
        task_lifecycle AS MATERIALIZED (
          SELECT
            activity_id,
            kind,
            sequence,
            created_at,
            json_extract(payload_json, '$.taskId') AS task_id,
            json_extract(payload_json, '$.parentAgentId') AS parent_agent_id,
            json_extract(payload_json, '$.status') AS status
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
            AND json_extract(payload_json, '$.taskId') IS NOT NULL
        ),
        task_status_votes AS (
          SELECT
            task_id,
            sequence,
            created_at,
            activity_id,
            CASE
              WHEN kind = 'task.completed'
                OR status IN ('completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'idle')
              THEN 1
              ELSE 0
            END AS settled
          FROM task_lifecycle
          WHERE kind = 'task.started'
            OR kind = 'task.completed'
            OR (kind = 'task.updated' AND status IS NOT NULL)
        ),
        task_latest_vote AS (
          SELECT
            task_id,
            settled,
            sequence,
            created_at,
            activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY task_id
              ORDER BY sequence DESC, created_at DESC, settled DESC, activity_id DESC
            ) AS vote_order
          FROM task_status_votes
          WHERE created_at >= COALESCE((SELECT created_at FROM latest_session_reset), '')
            AND (
              sequence IS NULL
              OR (SELECT sequence FROM latest_session_reset) IS NULL
              OR sequence > (SELECT sequence FROM latest_session_reset)
            )
        ),
        live_task_ids AS (
          SELECT task_id
          FROM task_latest_vote
          WHERE vote_order = 1
            AND settled = 0
          ORDER BY sequence DESC, created_at DESC, activity_id DESC
          LIMIT ${PINNED_LIVE_TASK_LIMIT}
        ),
        live_task_activity_ids AS (
          SELECT activity_id
          FROM task_lifecycle
          WHERE task_id IN (SELECT task_id FROM live_task_ids)
            OR parent_agent_id IN (SELECT task_id FROM live_task_ids)
        ),
  `;

  /** CTEs placed right before `pinned_activity_ids`. */
  const ctes = (threadId: string, includeLiveTasks: boolean) => sql`
        latest_session_reset AS (
          SELECT activity_id, sequence, created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind IN ('session.reset', 'runtime.error')
          ORDER BY sequence DESC, created_at DESC, activity_id DESC
          LIMIT 1
        ),
        ${includeLiveTasks ? liveTaskPinCtes(threadId) : sql``}
  `;

  /** `UNION ALL` branches appended to `pinned_activity_ids`. */
  const pinnedIds = (includeLiveTasks: boolean) => sql`
          UNION ALL
          SELECT activity_id FROM latest_session_reset
          ${includeLiveTasks ? sql`UNION ALL SELECT activity_id FROM live_task_activity_ids` : sql``}
  `;

  // Pinning only pays off on reads of a thread whose provider session can
  // still finish work: a dead session's tasks render interrupted on the
  // client regardless, and skipping the task scan keeps stopped threads
  // (often the largest) at the plain windowed cost.
  const shouldPinLiveTasks = (threadId: ThreadId) =>
    deps.getThreadSessionRowByThread({ threadId }).pipe(
      Effect.mapError(
        deps.toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadDetailById:getSessionForPinning:query",
          "ProjectionSnapshotQuery.getThreadDetailById:getSessionForPinning:decodeRow",
        ),
      ),
      Effect.map(
        (session) => Option.isSome(session) && !DEAD_SESSION_STATUSES.has(session.value.status),
      ),
    );

  return { ctes, pinnedIds, shouldPinLiveTasks };
};
