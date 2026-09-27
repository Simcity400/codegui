import {
  OrchestrationGetSnapshotError,
  OrchestrationThreadActivity,
  ThreadId,
  type AgentRoster,
  type AgentRosterStreamItem,
  type AgentTranscriptStreamItem,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  AGENT_ROSTER_ACTIVITY_KINDS,
  agentActivityOwner,
  agentRosterUpdate,
} from "@t3tools/shared/agentTranscripts";
import { foldThreadTasks } from "@t3tools/client-runtime/state/subagentRuntime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { projectActivityEvent, projectActivityPayload } from "./ActivityPayloadProjection.ts";
import { listAgentMessages } from "./agentMessages.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./LiveStreamBudget.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const snapshotError = (cause: unknown) =>
  new OrchestrationGetSnapshotError({
    message: "Could not load agent history.",
    cause,
  });
const isRosterActivity = (activity: OrchestrationThreadActivity) =>
  AGENT_ROSTER_ACTIVITY_KINDS.some((kind) => kind === activity.kind);
const isHistoryReset = (event: OrchestrationEvent) =>
  event.type === "thread.reverted" || event.type === "thread.deleted";

/** Subscribe before reading, with the same bounded slow-consumer protection as thread streams. */
const bufferEvents = Effect.fnUntraced(function* (
  threadId: ThreadId,
  accepts: (event: OrchestrationEvent) => boolean,
) {
  const engine = yield* OrchestrationEngineService;
  const source = yield* engine.subscribeDomainEvents;
  const budget = yield* makeLiveStreamBudget();
  const queue = yield* Queue.unbounded<
    RetainedLiveItem<OrchestrationEvent>,
    OrchestrationGetSnapshotError
  >();
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  yield* Effect.forkScoped(
    source.pipe(
      Stream.filter(
        (event) =>
          event.aggregateKind === "thread" && event.aggregateId === threadId && accepts(event),
      ),
      Stream.runForEach((event) =>
        budget
          .retain(projectActivityEvent(event))
          .pipe(Effect.flatMap((item) => Queue.offer(queue, item))),
      ),
      Effect.raceFirst(budget.failed),
      Effect.catchTags({ OrchestrationGetSnapshotError: (error) => Queue.fail(queue, error) }),
    ),
    { startImmediately: true },
  );
  return budget.deliver(Stream.fromQueue(queue));
});

/** Fold only roster lifecycle rows, once per batch; send bounded models instead of entire history pages. */
export const subscribeAgentRoster = (threadId: ThreadId) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activities = yield* ProjectionThreadActivityRepository;
      const snapshots = yield* ProjectionSnapshotQuery;
      const events = yield* bufferEvents(
        threadId,
        (event) =>
          isHistoryReset(event) ||
          event.type === "thread.session-set" ||
          (event.type === "thread.activity-appended" && isRosterActivity(event.payload.activity)),
      );
      let rows = new Map<string, OrchestrationThreadActivity>();
      let sessionLive = false;
      let sequence = 0;
      const reload = sql.withTransaction(
        Effect.gen(function* () {
          const stored = yield* activities.listByThreadId({
            threadId,
            activityKinds: [...AGENT_ROSTER_ACTIVITY_KINDS],
          });
          rows = new Map(
            stored.map(({ activityId, threadId: _threadId, ...activity }) => [
              activityId,
              { id: activityId, ...activity },
            ]),
          );
          const sessions = yield* sql<{
            status: string;
          }>`SELECT status FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
          sessionLive =
            sessions.length > 0 &&
            !["stopped", "interrupted", "error"].includes(sessions[0]!.status);
          sequence = (yield* snapshots.getSnapshotSequence()).snapshotSequence;
        }),
      );
      yield* reload;
      let previous: AgentRoster = foldThreadTasks([...rows.values()], { sessionLive });
      const initial: AgentRosterStreamItem = { kind: "snapshot", snapshot: previous };
      const updates = events.pipe(
        Stream.mapArrayEffect(
          Effect.fnUntraced(function* (batch) {
            let changed = false;
            for (const event of batch) {
              if (event.sequence <= sequence) continue;
              sequence = event.sequence;
              if (event.type === "thread.deleted") {
                rows.clear();
                sessionLive = false;
                changed = true;
              } else if (isHistoryReset(event)) {
                yield* reload;
                changed = true;
              } else if (event.type === "thread.session-set") {
                sessionLive =
                  event.payload.session !== null &&
                  !["stopped", "interrupted", "error"].includes(event.payload.session.status);
                changed = true;
              } else if (event.type === "thread.activity-appended") {
                const activity = { ...event.payload.activity, sequence: event.sequence };
                rows.delete(activity.id);
                rows.set(activity.id, activity);
                changed = true;
              }
            }
            if (!changed) return [null] as const;
            const next = foldThreadTasks([...rows.values()], { sessionLive });
            const update = agentRosterUpdate(previous, next);
            const sameOrder =
              update.agentIds.length === previous.agents.length &&
              update.agentIds.every((id, index) => id === previous.agents[index]?.id) &&
              update.backgroundTaskIds.length === previous.backgroundTasks.length &&
              update.backgroundTaskIds.every(
                (id, index) => id === previous.backgroundTasks[index]?.id,
              );
            previous = next;
            return update.agents.length === 0 && update.backgroundTasks.length === 0 && sameOrder
              ? ([null] as const)
              : ([{ kind: "update" as const, update }] as const);
          }),
        ),
        Stream.filter((item) => item !== null),
      );
      return Stream.concat(Stream.make(initial), updates);
    }).pipe(Effect.provide(ProjectionThreadActivityRepositoryLive), Effect.mapError(snapshotError)),
  ).pipe(Stream.mapError(snapshotError));

export const listAgentActivities = (
  sql: SqlClient.SqlClient,
  input: { threadId: ThreadId; agentId: string },
) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, agentId: Schema.String }),
    Result: OrchestrationThreadActivity.mapFields((fields) => ({
      ...fields,
      payload: Schema.fromJsonString(Schema.Unknown),
    })),
    execute: ({ threadId, agentId }) => sql`
      SELECT activity_id AS id, turn_id AS "turnId", tone, kind, summary,
        payload_json AS payload, COALESCE(sequence, 0) AS sequence, created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.agentId') = ${agentId}
      ORDER BY projection_thread_activities.sequence ASC, created_at ASC, activity_id ASC
    `,
  })(input);

/** Only an open transcript subscribes to its messages and tools. Reconnection starts from authoritative rows. */
export const subscribeAgentTranscript = (input: { threadId: ThreadId; agentId: string }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const events = yield* bufferEvents(
        input.threadId,
        (event) =>
          isHistoryReset(event) ||
          (event.type === "thread.message-sent" && event.payload.agentId === input.agentId) ||
          (event.type === "thread.activity-appended" &&
            agentActivityOwner(event.payload.activity) === input.agentId),
      );
      let sequence = 0;
      const read = sql.withTransaction(
        Effect.gen(function* () {
          const messages = yield* listAgentMessages(sql, input);
          const activities = yield* listAgentActivities(sql, input);
          sequence = (yield* snapshots.getSnapshotSequence()).snapshotSequence;
          return {
            kind: "snapshot" as const,
            snapshot: { messages, activities: activities.map(projectActivityPayload) },
          };
        }),
      );
      const initial: AgentTranscriptStreamItem = yield* read;
      return Stream.concat(
        Stream.make(initial),
        events.pipe(
          Stream.mapEffect(
            (event): Effect.Effect<AgentTranscriptStreamItem | null, Effect.Error<typeof read>> => {
              if (event.sequence <= sequence) return Effect.succeed(null);
              if (event.type === "thread.deleted") {
                sequence = event.sequence;
                return Effect.succeed({
                  kind: "snapshot",
                  snapshot: { messages: [], activities: [] },
                });
              }
              if (isHistoryReset(event)) return read;
              sequence = event.sequence;
              return Effect.succeed({ kind: "event", event });
            },
          ),
          Stream.filter((item) => item !== null),
        ),
      );
    }).pipe(Effect.mapError(snapshotError)),
  ).pipe(Stream.mapError(snapshotError));
