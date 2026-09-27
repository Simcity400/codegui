import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type AgentRosterStreamItem,
  type AgentTranscriptStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import {
  listAgentActivities,
  subscribeAgentRoster,
  subscribeAgentTranscript,
} from "./AgentStreams.ts";

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("thread");
const at = "2026-09-27T00:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/tmp/project', '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, 'project', 'Thread', '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
    VALUES (${threadId}, 'turn', 'parent', 'completed', ${at}, ${at}, ${at}, '[]')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, agent_id, is_streaming, created_at, updated_at)
    VALUES ('parent', ${threadId}, 'turn', 'user', 'Parent text', NULL, 0, ${at}, ${at}),
      ('child', ${threadId}, 'turn', 'assistant', 'Child text', 'agent', 1, ${at}, ${at})`;
  yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    VALUES ('parent-tool', ${threadId}, 'turn', 'tool', 'tool.completed', 'Parent tool', '{}', 1, ${at}),
      ('task', ${threadId}, 'turn', 'info', 'task.started', 'Task', '{"taskId":"agent","title":"Original title","agentKind":"agent"}', 2, ${at}),
      ('approval', ${threadId}, 'turn', 'info', 'approval.requested', 'Approval', '{"agentId":"agent","requestId":"request"}', 3, ${at})`;
  yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < 600)
    INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    SELECT 'child-' || n, ${threadId}, 'turn', 'tool', 'tool.completed', 'Child tool', '{"agentId":"agent","detail":"Child output"}', n+3, ${at} FROM numbers`;
});
const envelope = (sequence: number) => ({
  sequence,
  eventId: EventId.make(`e-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
const delta = (sequence: number, agentId = "agent"): OrchestrationEvent => ({
  ...envelope(sequence),
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make("child"),
    agentId,
    role: "assistant",
    text: " delta",
    streaming: true,
    turnId: null,
    createdAt: at,
    updatedAt: at,
  },
});

it.effect(
  "isolates child content before the parent activity limit, leaving legacy reads and requests intact",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const legacy = Option.getOrThrow(
        yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 10 }),
      );
      const parent = Option.getOrThrow(
        yield* query.getThreadDetailSnapshot(threadId, {
          turnLimit: 10,
          separateAgentTranscripts: true,
        }),
      );
      assert.isTrue(legacy.thread.messages.some((message) => message.agentId === "agent"));
      assert.isTrue(legacy.thread.activities.some((activity) => activity.id.startsWith("child-")));
      assert.deepEqual(
        parent.thread.messages.map((message) => message.id),
        ["parent"],
      );
      assert.deepEqual(
        parent.thread.activities.map((activity) => activity.id),
        ["parent-tool", "task", "approval"],
      );
      assert.equal((yield* listAgentActivities(sql, { threadId, agentId: "agent" })).length, 601);
      // Both fork reads must narrow through their own indexes, including an older window's LIMIT.
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT activity_id FROM projection_thread_activities
    WHERE thread_id = ${threadId} AND NOT (kind IN ('tool.started', 'tool.updated', 'tool.completed')
      AND COALESCE(length(trim(json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.agentId'))), 0) > 0)
    ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 500`;
      assert.isTrue(plan.some((row) => row.detail.includes("idx_fork_activity_parent")));
      const agentPlan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT activity_id FROM projection_thread_activities
    WHERE thread_id = ${threadId} AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.agentId') = 'agent'
    ORDER BY sequence, created_at, activity_id`;
      assert.isTrue(agentPlan.some((row) => row.detail.includes("idx_fork_activity_agent")));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "subscribes before the transcript snapshot, filters other agents and replaces reverted history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const output = yield* Queue.unbounded<AgentTranscriptStreamItem>();
      const snapshots = yield* ProjectionSnapshotQuery;
      let watermark = 603;
      let first = true;
      const stream = subscribeAgentTranscript({ threadId, agentId: "agent" }).pipe(
        Stream.provide(
          Layer.mock(OrchestrationEngineService, {
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
        Stream.provideService(ProjectionSnapshotQuery, {
          ...snapshots,
          getSnapshotSequence: () =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                yield* PubSub.publish(events, delta(604));
              }
              return { snapshotSequence: watermark };
            }),
        }),
      );
      yield* stream.pipe(
        Stream.runForEach((item) => Queue.offer(output, item)),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(output);
      assert.equal(initial.kind, "snapshot");
      if (initial.kind === "snapshot")
        assert.equal(initial.snapshot.messages[0]?.text, "Child text");
      const duringSnapshot = yield* Queue.take(output);
      assert.equal(duringSnapshot.kind, "event");
      yield* PubSub.publish(events, delta(605, "other-agent"));
      yield* PubSub.publish(events, delta(606));
      const live = yield* Queue.take(output);
      assert.equal(live.kind === "event" && live.event.sequence, 606);
      yield* sql`DELETE FROM projection_thread_messages WHERE agent_id = 'agent'`;
      yield* sql`DELETE FROM projection_thread_activities WHERE json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.agentId') = 'agent'`;
      watermark = 608;
      yield* PubSub.publishAll(events, [
        { ...envelope(607), type: "thread.reverted", payload: { threadId, turnCount: 0 } },
        delta(608),
        delta(609),
      ] satisfies ReadonlyArray<OrchestrationEvent>);
      const reset = yield* Queue.take(output);
      assert.deepEqual(reset, { kind: "snapshot", snapshot: { messages: [], activities: [] } });
      const after = yield* Queue.take(output);
      assert.equal(after.kind === "event" && after.event.sequence, 609);
      yield* PubSub.publish(events, {
        ...envelope(610),
        type: "thread.deleted",
        payload: { threadId, deletedAt: at },
      });
      assert.deepEqual(yield* Queue.take(output), {
        kind: "snapshot",
        snapshot: { messages: [], activities: [] },
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "loads a complete roster independently of thread pages and emits changed agents only",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const output = yield* Queue.unbounded<AgentRosterStreamItem>();
      yield* subscribeAgentRoster(threadId).pipe(
        Stream.provide(
          Layer.mock(OrchestrationEngineService, {
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
        Stream.runForEach((item) => Queue.offer(output, item)),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(output);
      assert.equal(initial.kind, "snapshot");
      if (initial.kind === "snapshot") {
        assert.equal(initial.snapshot.agents[0]?.title, "Original title");
        assert.equal(initial.snapshot.agents[0]?.status, "interrupted");
      }
      yield* PubSub.publish(events, {
        ...envelope(604),
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make("done"),
            kind: "task.completed",
            summary: "Done",
            payload: { taskId: "agent", status: "completed", usage: { totalTokens: 42 } },
            tone: "info",
            turnId: null,
            createdAt: at,
          },
        },
      });
      const update = yield* Queue.take(output);
      assert.equal(update.kind, "update");
      if (update.kind === "update") {
        assert.equal(update.update.agents[0]?.status, "completed");
        assert.equal(update.update.agents[0]?.title, "Original title");
        assert.deepEqual(update.update.agentIds, ["agent"]);
      }
      yield* PubSub.publish(events, {
        ...envelope(605),
        type: "thread.deleted",
        payload: { threadId, deletedAt: at },
      });
      assert.deepEqual(yield* Queue.take(output), {
        kind: "update",
        update: { agents: [], backgroundTasks: [], agentIds: [], backgroundTaskIds: [] },
      });
    }).pipe(Effect.provide(layer)),
);
