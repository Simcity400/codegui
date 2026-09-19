import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import type { CodexGoal, OrchestrationMessage, OrchestrationThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  codexGoalSessionActivity,
  codexGoalStatusAction,
  findCodexGoalReportMessage,
  formatCodexGoalDescription,
  formatCodexGoalDuration,
  formatCodexGoalError,
  formatCodexGoalStatus,
  formatCodexGoalUsage,
  formatCodexGoalUsageCompact,
  parseCodexGoalCommand,
  toCodexGoalSetInput,
} from "./threadCommands.ts";

const threadId = ThreadId.make("thread-1");
const goal = (objective: string, status: CodexGoal["status"] = "active"): CodexGoal => ({
  objective,
  status,
  tokenBudget: 100_000,
  tokensUsed: 12_000,
  timeUsedSeconds: 90,
  createdAt: 1_777_000_000,
  updatedAt: 1_777_000_090,
});

describe("parseCodexGoalCommand", () => {
  it("maps all supported Goal commands to native mutations", () => {
    const cases = [
      ["/goal", { action: "edit" }],
      ["/goal edit", { action: "edit" }],
      ["/goal status", { action: "status" }],
      ["/goal create Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal steer Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal edit Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal pause", { action: "set", status: "paused" }],
      ["/goal resume", { action: "set", status: "active" }],
      ["/goal clear", { action: "clear" }],
      ["/goal reset", { action: "clear" }],
      ["please create a goal", null],
    ] as const;
    for (const [command, expected] of cases) {
      expect(parseCodexGoalCommand(command)).toEqual(expected);
    }
  });

  it("rejects arguments the native commands do not take", () => {
    for (const command of ["/goal pause now", "/goal clear it", "/goal create", "/goal steer"]) {
      expect(parseCodexGoalCommand(command)?.action).toBe("invalid");
    }
  });
});

describe("toCodexGoalSetInput", () => {
  it("adds the thread id without inventing omitted native fields", () => {
    expect(toCodexGoalSetInput(threadId, { action: "set", objective: "Ship it" })).toEqual({
      threadId,
      objective: "Ship it",
    });
  });
});

describe("goal formatting", () => {
  it("formats native usage consistently for clients", () => {
    expect(formatCodexGoalUsage(goal("Ship it"))).toBe("12,000 / 100,000 tokens · 1m");
    expect(formatCodexGoalUsage({ ...goal("Ship it"), tokenBudget: null })).toBe(
      "12,000 tokens · 1m",
    );
    expect(formatCodexGoalDescription(goal("Ship it"))).toBe(
      "Ship it - 12,000 / 100,000 tokens · 1m",
    );
  });

  it("compacts usage for the one-line goal row", () => {
    expect(formatCodexGoalUsageCompact(goal("Ship it"))).toBe("12k / 100k tokens · 1m");
    expect(formatCodexGoalUsageCompact({ ...goal("Ship it"), tokenBudget: null })).toBe(
      "12k tokens · 1m",
    );
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 950, tokenBudget: 2_500 }),
    ).toBe("950 / 2.5k tokens · 1m");
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 1_250_000, tokenBudget: null }),
    ).toBe("1.3M tokens · 1m");
    expect(
      formatCodexGoalUsageCompact({ ...goal("Ship it"), tokensUsed: 9_960, tokenBudget: 999_600 }),
    ).toBe("10k / 1M tokens · 1m");
  });

  it("formats elapsed time at the coarsest useful unit", () => {
    expect(formatCodexGoalDuration(28_458)).toBe("7h 54m");
    expect(formatCodexGoalDuration(125)).toBe("2m");
    expect(formatCodexGoalDuration(45)).toBe("45s");
  });

  it("uses Codex's own status wording", () => {
    const statuses = [
      "active",
      "paused",
      "budgetLimited",
      "usageLimited",
      "complete",
      "blocked",
    ] as const;
    expect(statuses.map(formatCodexGoalStatus)).toEqual([
      "active",
      "paused",
      "budget limited",
      "usage limited",
      "complete",
      "stalled",
    ]);
  });
});

describe("goal status controls", () => {
  it("derives session activity from the provider session", () => {
    expect(codexGoalSessionActivity(null)).toBe("stopped");
    expect(codexGoalSessionActivity({ status: "stopped" } as never)).toBe("stopped");
    expect(codexGoalSessionActivity({ status: "running" } as never)).toBe("running");
    expect(codexGoalSessionActivity({ status: "starting" } as never)).toBe("running");
    expect(codexGoalSessionActivity({ status: "ready" } as never)).toBe("idle");
  });

  it("offers pause while active, continue once the thread stopped, resume when halted", () => {
    expect(codexGoalStatusAction(goal("x"), "running")).toBe("pause");
    expect(codexGoalStatusAction(goal("x"), "idle")).toBe("pause");
    expect(codexGoalStatusAction(goal("x"), "stopped")).toBe("continue");
    for (const status of ["paused", "blocked", "usageLimited", "budgetLimited"] as const) {
      expect(codexGoalStatusAction(goal("x", status), "stopped")).toBe("resume");
    }
    expect(codexGoalStatusAction(goal("x", "complete"), "stopped")).toBeNull();
  });
});

describe("findCodexGoalReportMessage", () => {
  const message = (
    id: string,
    role: OrchestrationMessage["role"],
    turnId: string | null,
    text = "text",
    agentId?: string,
  ): OrchestrationMessage => ({
    id: MessageId.make(id),
    role,
    text,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(agentId === undefined ? {} : { agentId }),
  });
  const blockedGoal: OrchestrationThreadGoal = {
    ...goal("x", "blocked"),
    turnId: TurnId.make("turn-2"),
  };

  it("returns the root assistant message that ended the reporting turn", () => {
    const messages = [
      message("m1", "assistant", "turn-1", "earlier"),
      message("m2", "user", "turn-2", "go"),
      message("m3", "assistant", "turn-2", "progress"),
      message("m4", "assistant", "turn-2", "child", "agent-1"),
      message("m5", "assistant", "turn-2", "Blocked on credentials"),
      message("m6", "assistant", "turn-2", "   "),
    ];
    expect(findCodexGoalReportMessage(messages, blockedGoal)?.id).toBe("m5");
  });

  it("returns nothing when the update was not tied to a turn", () => {
    expect(
      findCodexGoalReportMessage([message("m1", "assistant", "turn-2")], {
        ...blockedGoal,
        turnId: null,
      }),
    ).toBeNull();
  });
});

describe("formatCodexGoalError", () => {
  it("appends the provider reason carried in the error cause", () => {
    const error = new Error("Codex Goal set failed for thread thread-1", {
      cause: new Error("Provider 'claude' is not implemented"),
    });
    expect(formatCodexGoalError(error)).toBe(
      "Codex Goal set failed for thread thread-1: Provider 'claude' is not implemented",
    );
  });

  it("falls back to the wrapper message when the cause carries no reason", () => {
    expect(formatCodexGoalError(new Error("Codex Goal set failed for thread thread-1"))).toBe(
      "Codex Goal set failed for thread thread-1",
    );
  });

  it("handles non-error failures", () => {
    expect(formatCodexGoalError("boom")).toBe("Codex Goal operation failed.");
  });
});
