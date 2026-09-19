import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const retiredMigrations = new Set([
  "ProjectionThreadMessageAgentId",
  "ProjectionThreadSideChats",
  "CrossProviderRecoveryIndexes",
  "ProjectionThreadsGoal",
]);

// The old fork inserted migrations into upstream's sequence. Reconcile by name
// before the upstream migrator checks the maximum ID, keeping the old ledger.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
      if (tables.length === 0) return;
      const rows = yield* sql<{ migration_id: number; name: string; created_at: string }>`
      SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
    `;
      if (
        !rows.some(
          (row) => row.migration_id === 41 && row.name === "ProjectionThreadMessageAgentId",
        )
      )
        return;
      const upstreamIds = new Map(manifest.map(([id, name]) => [name, id]));
      for (const row of rows) {
        if (!upstreamIds.has(row.name) && !retiredMigrations.has(row.name)) {
          return yield* Effect.die(
            new Error(`Unrecognized fork migration: ${row.migration_id}_${row.name}`),
          );
        }
      }
      yield* sql`CREATE TABLE IF NOT EXISTS retired_fork_migrations AS SELECT * FROM effect_sql_migrations`;
      // Requests owned by the removed bridge cannot be answered anymore. Keep
      // their activity payloads as history, but stop exposing actionable cards.
      yield* sql`DELETE FROM projection_pending_approvals WHERE request_id IN (
      SELECT json_extract(payload_json, '$.requestId') FROM projection_thread_activities
      WHERE kind = 'approval.requested' AND json_type(payload_json, '$.bridgeAgentId') = 'text'
    )`;
      yield* sql`UPDATE projection_thread_activities SET kind = 'legacy.' || kind
      WHERE kind IN ('approval.requested', 'user-input.requested')
      AND json_type(payload_json, '$.bridgeAgentId') = 'text'`;
      yield* sql`UPDATE projection_threads SET pending_approval_count = (
      SELECT COUNT(*) FROM projection_pending_approvals
      WHERE thread_id = projection_threads.thread_id AND status = 'pending'
    )`;
      yield* sql`UPDATE projection_threads SET pending_user_input_count = (
      SELECT COUNT(*) FROM (
        SELECT kind, ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload_json, '$.requestId')
          ORDER BY created_at DESC, activity_id DESC
        ) AS position
        FROM projection_thread_activities
        WHERE thread_id = projection_threads.thread_id
          AND json_type(payload_json, '$.requestId') = 'text'
          AND (kind IN ('user-input.requested', 'user-input.resolved') OR (
            kind = 'provider.user-input.respond.failed' AND (
              lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
            )
          ))
      ) WHERE position = 1 AND kind = 'user-input.requested'
    )`;
      yield* sql`DELETE FROM effect_sql_migrations`;
      for (const row of rows) {
        const id = upstreamIds.get(row.name);
        if (id !== undefined) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${row.name}, ${row.created_at})`;
        }
      }
    }),
  );
});

// Keep the personal extensions outside upstream's numbered migration
// namespace so future upstream migrations cannot collide with it again.
export const ensureForkColumns = Effect.fn("ensureForkColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
      if (columns.length > 0 && !columns.some((column) => column.name === "agent_id")) {
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN agent_id TEXT`;
      }
      const threadColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      if (threadColumns.length > 0) {
        if (!threadColumns.some((column) => column.name === "forked_from_thread_id")) {
          yield* sql`ALTER TABLE projection_threads ADD COLUMN forked_from_thread_id TEXT`;
        }
        if (!threadColumns.some((column) => column.name === "side_chat_promoted_at")) {
          yield* sql`ALTER TABLE projection_threads ADD COLUMN side_chat_promoted_at TEXT`;
        }
      }
      if (
        threadColumns.length > 0 &&
        !threadColumns.some((column) => column.name === "goal_json")
      ) {
        yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_json TEXT`;
      }
      // Agent-scoped detail reads filter on this side table instead of the
      // activity payloads, which run to megabytes per row. Backfilling reads
      // every payload once; adding a column would rewrite every row instead.
      const activityColumns = yield* sql<{
        name: string;
      }>`PRAGMA table_info(projection_thread_activities)`;
      const agentTables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_activity_agents'`;
      if (activityColumns.length > 0 && agentTables.length === 0) {
        yield* sql`CREATE TABLE projection_thread_activity_agents (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          sequence INTEGER
        )`;
        yield* sql`CREATE INDEX idx_projection_thread_activity_agents_thread_agent_sequence
          ON projection_thread_activity_agents (thread_id, agent_id, sequence)`;
        yield* sql`INSERT INTO projection_thread_activity_agents (activity_id, thread_id, agent_id, sequence)
          SELECT activity_id, thread_id, json_extract(payload_json, '$.agentId'), sequence
          FROM projection_thread_activities
          WHERE json_type(payload_json, '$.agentId') = 'text'
            AND length(trim(json_extract(payload_json, '$.agentId'))) > 0`;
      }
      // Thread-detail reads pin the lifecycle rows of still-running tasks
      // onto every page (ProjectionSnapshotQuery). Narrowing on kind keeps
      // that scan to task rows; without it a large live thread pays a full
      // per-thread activity scan on every read. Lives here, not in a numbered
      // migration: upstream already owns the next ids on forked databases.
      if (activityColumns.length > 0) {
        yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
          ON projection_thread_activities (thread_id, kind)`;
      }
    }),
  );
});
