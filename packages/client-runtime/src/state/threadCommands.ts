import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import {
  type CodexGoal,
  type CodexGoalSetInput,
  type CodexGoalStatus,
  type CodexGoalUserStatus,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadGoal,
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import { canSnooze } from "./threadSettled.ts";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type LinkThreadPullRequestInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type DismissThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type ReorderActiveThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnlinkThreadPullRequestInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type CodexGoalCommand =
  | { readonly action: "status" }
  | { readonly action: "edit" }
  | {
      readonly action: "set";
      readonly objective?: string;
      readonly status?: CodexGoalUserStatus;
    }
  | { readonly action: "clear" }
  | { readonly action: "invalid"; readonly message: string };

const GOAL_USAGE =
  "Usage: /goal [status | create <objective> | steer <objective> | edit | pause | resume | clear]";

/** "7h 54m", "12m", or "45s": how long Codex has spent on the goal. */
export function formatCodexGoalDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(0, Math.floor(seconds))}s`;
}

export function formatCodexGoalUsage(goal: CodexGoal): string {
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget.toLocaleString()}`;
  return `${goal.tokensUsed.toLocaleString()}${budget} tokens · ${formatCodexGoalDuration(goal.timeUsedSeconds)}`;
}

export function formatCodexGoalDescription(goal: CodexGoal): string {
  return `${goal.objective} - ${formatCodexGoalUsage(goal)}`;
}

function formatCompactTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  // Round before picking the unit so 9,960 reads "10k" and 999,600 reads "1M".
  const thousands = tokens / 1_000;
  if (Number(thousands.toFixed(1)) < 10) return `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
  const roundedThousands = Math.round(thousands);
  if (roundedThousands < 1_000) return `${roundedThousands}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** One-line usage for the goal row above the composer: "12k / 100k tokens · 1m". */
export function formatCodexGoalUsageCompact(goal: CodexGoal): string {
  const budget = goal.tokenBudget == null ? "" : ` / ${formatCompactTokenCount(goal.tokenBudget)}`;
  return `${formatCompactTokenCount(goal.tokensUsed)}${budget} tokens · ${formatCodexGoalDuration(goal.timeUsedSeconds)}`;
}

// Codex's own wording: its terminal shows a blocked goal as "stalled".
const CODEX_GOAL_STATUS_LABELS: Record<CodexGoalStatus, string> = {
  active: "active",
  paused: "paused",
  blocked: "stalled",
  usageLimited: "usage limited",
  budgetLimited: "budget limited",
  complete: "complete",
};

export function formatCodexGoalStatus(status: CodexGoalStatus): string {
  return CODEX_GOAL_STATUS_LABELS[status];
}

/** Whether the provider session that would run goal turns is live right now. */
export type CodexGoalSessionActivity = "running" | "idle" | "stopped";

export function codexGoalSessionActivity(
  session: OrchestrationThread["session"],
): CodexGoalSessionActivity {
  if (session === null || session.status === "stopped" || session.status === "error") {
    return "stopped";
  }
  // A starting session is about to work, not resting between goal turns.
  return session.status === "running" || session.status === "starting" ? "running" : "idle";
}

/**
 * The one status control the goal offers besides edit and clear. Continue
 * re-asserts an active goal on a stopped thread, which wakes the provider
 * session; Codex then resumes the goal on its own.
 */
export function codexGoalStatusAction(
  goal: CodexGoal,
  activity: CodexGoalSessionActivity,
): "pause" | "resume" | "continue" | null {
  switch (goal.status) {
    case "active":
      return activity === "stopped" ? "continue" : "pause";
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return "resume";
    case "complete":
      return null;
  }
}

/**
 * The assistant message that ended the turn Codex last reported the goal
 * from: for a blocked goal, the message explaining the blocker.
 */
export function findCodexGoalReportMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  goal: OrchestrationThreadGoal,
): OrchestrationMessage | null {
  if (goal.turnId === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message !== undefined &&
      message.role === "assistant" &&
      message.agentId === undefined &&
      message.turnId === goal.turnId &&
      message.text.trim() !== ""
    ) {
      return message;
    }
  }
  return null;
}

export function formatCodexGoalError(error: unknown): string {
  if (!(error instanceof Error)) return "Codex Goal operation failed.";
  const reason = error.cause instanceof Error ? error.cause.message.trim() : "";
  return reason.length === 0 ? error.message : `${error.message}: ${reason}`;
}

export function parseCodexGoalCommand(value: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(value.trim());
  if (match === null) return null;

  const argument = match[1]?.trim() ?? "";
  if (argument === "") return { action: "edit" };

  const [rawAction = "", ...rest] = argument.split(/\s+/);
  const action = rawAction.toLowerCase();
  const objective = rest.join(" ").trim();
  const invalid = { action: "invalid", message: GOAL_USAGE } as const;
  if (action === "status") return objective === "" ? { action: "status" } : invalid;
  if (action === "create") {
    return objective === "" ? invalid : { action: "set", objective, status: "active" };
  }
  if (action === "steer") return objective === "" ? invalid : { action: "set", objective };
  if (action === "edit")
    return objective === "" ? { action: "edit" } : { action: "set", objective };
  if (action === "pause" || action === "resume") {
    if (objective !== "") return invalid;
    return { action: "set", status: action === "pause" ? "paused" : "active" };
  }
  if (action === "clear" || action === "reset") {
    return objective === "" ? { action: "clear" } : invalid;
  }

  return { action: "set", objective: argument, status: "active" };
}

export function toCodexGoalSetInput(
  threadId: CodexGoalSetInput["threadId"],
  command: Extract<CodexGoalCommand, { readonly action: "set" }>,
): CodexGoalSetInput {
  const { action: _action, ...input } = command;
  return { threadId, ...input };
}

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  LinkThreadPullRequestInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  DismissThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  ReorderActiveThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnlinkThreadPullRequestInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const commands = {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: ReorderActiveThreadInput) => reorderActiveThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: (input: LinkThreadPullRequestInput) => linkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: (input: UnlinkThreadPullRequestInput) => unlinkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: (input: DismissThreadUserInputInput) => dismissThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    setCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:set",
      tag: WS_METHODS.codexGoalSet,
      scheduler,
      concurrency,
    }),
    clearCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:clear",
      tag: WS_METHODS.codexGoalClear,
      scheduler,
      concurrency,
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const optimistic = createOptimisticThreadLifecycle(snapshotAtom);
  return {
    ...commands,
    snapshotAtom: optimistic.snapshotAtom,
    settle: optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
      !accepted &&
      (!canSnooze(thread, { now }) ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running")
        ? thread
        : {
            ...thread,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            settledOverride: "settled",
            settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
            unsettledAt: null,
            activeOrderKey: null,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted && !canSnooze(thread, { now })) ||
      !(Date.parse(input.snoozedUntil) > Date.parse(now))
        ? thread
        : {
            ...thread,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            snoozedUntil: input.snoozedUntil,
            snoozedAt: thread.snoozedUntil === input.snoozedUntil ? (thread.snoozedAt ?? now) : now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
  };
}
