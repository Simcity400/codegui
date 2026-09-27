import * as Schema from "effect/Schema";

/** The bounded roster shared by the fork's server, web and mobile surfaces. */
export const RuntimeSubagent = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "subagent",
    "subagent_batch",
    "workflow",
    "workflow_agent",
    "background_task",
  ]),
  title: Schema.String,
  role: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "idle",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  activationCount: Schema.Number,
  usage: Schema.NullOr(
    Schema.Struct({
      totalTokens: Schema.Number,
      inputTokens: Schema.optionalKey(Schema.Number),
      cachedInputTokens: Schema.optionalKey(Schema.Number),
      outputTokens: Schema.optionalKey(Schema.Number),
      reasoningOutputTokens: Schema.optionalKey(Schema.Number),
      toolUses: Schema.optionalKey(Schema.Number),
      durationMs: Schema.optionalKey(Schema.Number),
    }),
  ),
  progress: Schema.NullOr(Schema.String),
  lastToolName: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  outputFile: Schema.NullOr(Schema.String),
  parentAgentId: Schema.NullOr(Schema.String),
  agentIndex: Schema.NullOr(Schema.Number),
  phaseIndex: Schema.NullOr(Schema.Number),
  phaseTitle: Schema.NullOr(Schema.String),
  attempt: Schema.NullOr(Schema.Number),
  workflowName: Schema.NullOr(Schema.String),
  phases: Schema.Array(Schema.Struct({ index: Schema.Number, title: Schema.String })),
  runHandles: Schema.NullOr(
    Schema.Struct({
      runId: Schema.optionalKey(Schema.String),
      scriptPath: Schema.optionalKey(Schema.String),
      transcriptDir: Schema.optionalKey(Schema.String),
      sessionUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  recentActivity: Schema.Array(Schema.Struct({ at: Schema.String, summary: Schema.String })),
  taskType: Schema.NullOr(Schema.String),
  owningAgentId: Schema.NullOr(Schema.String),
  agentPath: Schema.NullOr(Schema.String),
  toolUseId: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type RuntimeSubagent = typeof RuntimeSubagent.Type;

export const AgentRoster = Schema.Struct({
  agents: Schema.Array(RuntimeSubagent),
  backgroundTasks: Schema.Array(RuntimeSubagent),
});
export type AgentRoster = typeof AgentRoster.Type;

/** Each update carries only changed entries and the current bounded display order. */
export const AgentRosterUpdate = Schema.Struct({
  agents: Schema.Array(RuntimeSubagent),
  backgroundTasks: Schema.Array(RuntimeSubagent),
  agentIds: Schema.Array(Schema.String),
  backgroundTaskIds: Schema.Array(Schema.String),
});
export type AgentRosterUpdate = typeof AgentRosterUpdate.Type;
