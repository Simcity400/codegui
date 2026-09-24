import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("replays goal events stored by earlier fork builds", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("retired-goal-thread");
      const rows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'retired-goal-set', 'thread', ${threadId}, 0, 'thread.goal-set',
          '2026-01-01T00:00:00.000Z', 'server',
          '{"threadId":"retired-goal-thread","goal":{"objective":"Ship","status":"active","turnId":null}}',
          '{}'
        )
        RETURNING sequence
      `;

      const events = yield* store
        .readAggregateRange({
          aggregateKind: "thread",
          aggregateId: threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: rows[0]!.sequence,
        })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.type),
        ["thread.goal-set"],
      );
    }),
  );
});
