import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CODEX_GOAL_OBJECTIVE_MAX_CHARS = 4_000;
const CodexGoalObjective = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (objective) =>
      Array.from(objective).length <= CODEX_GOAL_OBJECTIVE_MAX_CHARS ||
      `Goal objective must not exceed ${CODEX_GOAL_OBJECTIVE_MAX_CHARS} characters.`,
  ),
);
export const CodexGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type CodexGoalStatus = typeof CodexGoalStatus.Type;
export const CodexGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: CodexGoalStatus,
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
});
export type CodexGoal = typeof CodexGoal.Type;
export const CodexGoalThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type CodexGoalThreadInput = typeof CodexGoalThreadInput.Type;
/**
 * Only pause and resume are user-driven status changes: Codex itself marks
 * a goal blocked, usage-limited, budget-limited, or complete.
 */
export const CodexGoalUserStatus = Schema.Literals(["active", "paused"]);
export type CodexGoalUserStatus = typeof CodexGoalUserStatus.Type;
export const CodexGoalSetInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optionalKey(CodexGoalObjective),
  status: Schema.optionalKey(CodexGoalUserStatus),
  tokenBudget: Schema.optionalKey(Schema.NullOr(PositiveInt)),
});
export type CodexGoalSetInput = typeof CodexGoalSetInput.Type;
export const CodexGoalClearResult = Schema.Struct({
  cleared: Schema.Boolean,
});
export type CodexGoalClearResult = typeof CodexGoalClearResult.Type;
export const CodexGoalOperation = Schema.Literals(["set", "clear"]);
export type CodexGoalOperation = typeof CodexGoalOperation.Type;

export class CodexGoalOperationError extends Schema.TaggedError<CodexGoalOperationError>()(
  "CodexGoalOperationError",
  {
    operation: CodexGoalOperation,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Codex Goal ${this.operation} failed for thread ${this.threadId}`;
  }
}
