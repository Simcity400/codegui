import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("fork compatibility", (it) => {
  it.effect("adds side chat columns on a fresh database and reruns cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "forked_from_thread_id"));
      assert.isTrue(columns.some((column) => column.name === "side_chat_promoted_at"));
      assert.isTrue(columns.some((column) => column.name === "goal_json"));
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );

  it.effect("tolerates an old fork ledger and keeps its data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id + 100 WHERE migration_id >= 41`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'ProjectionThreadMessageAgentId'), (42, 'ProjectionThreadSideChats')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
        VALUES ('saved-thread', 'saved-project', 'Existing conversation', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT title FROM projection_threads`, [
        { title: "Existing conversation" },
      ]);
      const ledger = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(
        ledger.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      const archived = yield* sql`SELECT name FROM retired_fork_migrations WHERE migration_id = 41`;
      assert.deepEqual(archived, [{ name: "ProjectionThreadMessageAgentId" }]);
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "forked_from_thread_id"));
      assert.isTrue(columns.some((column) => column.name === "side_chat_promoted_at"));
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
