import {
  ChatAttachment,
  OrchestrationMessageContext,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";

const AgentMessageRow = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    agentId: Schema.NullOr(TrimmedNonEmptyString),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);

/**
 * Every stored message of one subagent, oldest first, for its transcript.
 * Windowed thread pages leave finished subagent messages out, so this is the
 * only way a client reads them. Served by the (thread_id, agent_id, created_at)
 * index.
 */
export const listAgentMessages = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: ThreadId; readonly agentId: string },
) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, agentId: Schema.String }),
    Result: AgentMessageRow,
    execute: ({ threadId, agentId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        agent_id AS "agentId",
        context_json AS "context",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND agent_id = ${agentId}
      ORDER BY created_at ASC, message_id ASC
    `,
  })(input).pipe(
    Effect.map((rows) =>
      rows.map((row): OrchestrationMessage => ({
        id: row.messageId,
        role: row.role,
        text: row.text,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        ...(row.agentId !== null ? { agentId: row.agentId } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    ),
  );
