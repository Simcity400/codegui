import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

for (const through of [40, 47, 49]) {
  it.layer(NodeSqliteClient.layerMemory())(
    `fork compatibility through upstream ${through}`,
    (it) => {
      it.effect(
        "preserves data, reconciles fork numbering, and applies missing upstream migrations",
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runMigrations({ toMigrationInclusive: through });
            yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id + 100 WHERE migration_id >= 41`;
            yield* sql`UPDATE effect_sql_migrations SET migration_id = CASE WHEN migration_id >= 148 THEN migration_id - 96 ELSE migration_id - 98 END WHERE migration_id >= 141`;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'ProjectionThreadMessageAgentId'), (42, 'ProjectionThreadSideChats')`;
            if (through >= 47) {
              yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (50, 'CrossProviderRecoveryIndexes'), (51, 'ProjectionThreadsGoal')`;
            }
            yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
          VALUES ('saved-thread', 'saved-project', 'Existing conversation', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
            yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
          VALUES ('bridge-request', 'saved-thread', 'approval', 'approval.requested', 'Old bridge request', '{"bridgeAgentId":"child","requestId":"bridge-request"}', '2026-01-01T00:00:00.000Z'),
          ('native-request', 'saved-thread', 'approval', 'approval.requested', 'Native request', '{"requestId":"native-request"}', '2026-01-01T00:00:00.000Z')`;
            yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, status, created_at)
          VALUES ('bridge-request', 'saved-thread', 'pending', '2026-01-01T00:00:00.000Z'), ('native-request', 'saved-thread', 'pending', '2026-01-01T00:00:00.000Z')`;
            yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
              VALUES ('bridge-question', 'saved-thread', 'info', 'user-input.requested', 'Old question', '{"bridgeAgentId":"child","requestId":"bridge-question"}', '2026-01-01T00:00:00.000Z'),
              ('native-question', 'saved-thread', 'info', 'user-input.requested', 'Native question', '{"requestId":"native-question"}', '2026-01-01T00:00:00.000Z')`;
            yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, agent_id, is_streaming, created_at, updated_at)
          VALUES ('child-message', 'saved-thread', NULL, 'assistant', 'Keep this transcript', 'child-agent', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
            if (through >= 47) {
              yield* sql`UPDATE projection_threads SET goal_json = '{"objective":"Keep my goal","status":"paused","tokensUsed":7,"timeUsedSeconds":2,"createdAt":1,"updatedAt":2,"turnId":null}' WHERE thread_id = 'saved-thread'`;
            }
            yield* runMigrations();
            assert.deepEqual(
              yield* sql`SELECT json_extract(goal_json, '$.objective') AS objective FROM projection_threads`,
              [{ objective: through >= 47 ? "Keep my goal" : null }],
            );
            assert.deepEqual(
              yield* sql`SELECT title, pending_approval_count, pending_user_input_count FROM projection_threads`,
              [
                {
                  title: "Existing conversation",
                  pending_approval_count: 1,
                  pending_user_input_count: 1,
                },
              ],
            );
            assert.deepEqual(yield* sql`SELECT request_id FROM projection_pending_approvals`, [
              { request_id: "native-request" },
            ]);
            assert.deepEqual(
              yield* sql`SELECT kind FROM projection_thread_activities WHERE activity_id = 'bridge-request'`,
              [{ kind: "legacy.approval.requested" }],
            );
            assert.deepEqual(yield* sql`SELECT text, agent_id FROM projection_thread_messages`, [
              { text: "Keep this transcript", agent_id: "child-agent" },
            ]);
            const ledger = yield* sql<{
              migration_id: number;
              name: string;
            }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
            assert.deepEqual(
              ledger.map((row) => [row.migration_id, row.name]),
              migrationManifest.map(([id, name]) => [id, name]),
            );
            const archived =
              yield* sql`SELECT name FROM retired_fork_migrations WHERE migration_id = 41`;
            assert.deepEqual(archived, [{ name: "ProjectionThreadMessageAgentId" }]);
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
            assert.isTrue(columns.some((column) => column.name === "active_order_key"));
            assert.deepEqual(yield* runMigrations(), []);
          }),
      );
    },
  );
}

it.layer(NodeSqliteClient.layerMemory())("upstream database compatibility", (it) => {
  it.effect("adds attribution to an upstream database without changing its ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`ALTER TABLE projection_thread_messages DROP COLUMN agent_id`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN goal_json`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN forked_from_thread_id`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN side_chat_promoted_at`;
      yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_kind`;
      assert.deepEqual(yield* runMigrations(), []);
      // The live-task pin's index rides outside the numbered ledger, so a
      // database already past upstream's next ids still gets it.
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projection_thread_activities_thread_kind'`,
        [{ name: "idx_projection_thread_activities_thread_kind" }],
      );
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isTrue(columns.some((column) => column.name === "agent_id"));
      const threadColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(threadColumns.some((column) => column.name === "goal_json"));
      assert.isTrue(threadColumns.some((column) => column.name === "forked_from_thread_id"));
      assert.isTrue(threadColumns.some((column) => column.name === "side_chat_promoted_at"));
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'retired_fork_migrations'`,
        [],
      );
    }),
  );

  it.effect("backfills activity attribution for agent-scoped reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DROP TABLE projection_thread_activity_agents`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('root-tool', 'thread-a', 'tool', 'tool.completed', 'root', '{"itemType":"command_execution"}', 1, '2026-01-01T00:00:00.000Z'),
          ('agent-tool', 'thread-a', 'tool', 'tool.completed', 'agent', '{"itemType":"command_execution","agentId":"worker"}', 2, '2026-01-01T00:00:00.000Z'),
          ('blank-agent', 'thread-a', 'tool', 'tool.completed', 'blank', '{"agentId":" "}', 3, '2026-01-01T00:00:00.000Z')`;
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT activity_id, agent_id, sequence FROM projection_thread_activity_agents ORDER BY sequence`,
        [{ activity_id: "agent-tool", agent_id: "worker", sequence: 2 }],
      );
    }),
  );
});
