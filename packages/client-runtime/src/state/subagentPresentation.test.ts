import { describe, expect, it } from "vite-plus/test";
import {
  backgroundTaskTypeLabel,
  buildAgentFamilies,
  compareSubagentsInSection,
  familyPanelSection,
  flattenAgentFamily,
  formatSubagentElapsed,
  isSubagentSessionLive,
  subagentActivityText,
  subagentStatusLabel,
} from "./subagentPresentation.ts";

describe("subagent presentation", () => {
  it("leads live rows with current activity and settled rows with the outcome", () => {
    const base = { progress: "Reading b.ts", lastToolName: "Grep", result: "Done", error: null };
    expect(subagentActivityText({ ...base, status: "running" })).toBe("Reading b.ts");
    expect(subagentActivityText({ ...base, status: "completed" })).toBe("Done");
    expect(subagentActivityText({ ...base, status: "failed", error: "boom" })).toBe("boom");
    expect(
      subagentActivityText({
        status: "waiting",
        progress: null,
        lastToolName: "Bash",
        result: null,
        error: null,
      }),
    ).toBe("▸ Bash");
  });
  it("labels every live state as working and only idle batches as plain idle", () => {
    expect(subagentStatusLabel({ kind: "subagent", status: "waiting" })).toBe("Working");
    expect(subagentStatusLabel({ kind: "subagent", status: "idle" })).toBe("Idle · resumable");
    expect(subagentStatusLabel({ kind: "subagent_batch", status: "idle" })).toBe("Idle");
    expect(subagentStatusLabel({ kind: "workflow", status: "interrupted" })).toBe("Stopped");
  });
  it("labels background tasks as running rather than working, with a type label", () => {
    expect(subagentStatusLabel({ kind: "background_task", status: "running" })).toBe("Running");
    expect(subagentStatusLabel({ kind: "background_task", status: "completed" })).toBe("Completed");
    expect(subagentStatusLabel({ kind: "background_task", status: "interrupted" })).toBe("Stopped");
    expect(backgroundTaskTypeLabel("local_bash")).toBe("Shell");
    expect(backgroundTaskTypeLabel("monitor_mcp")).toBe("Monitor");
    expect(backgroundTaskTypeLabel(null)).toBe("Task");
    expect(backgroundTaskTypeLabel("custom_kind")).toBe("Custom kind");
  });
  it("treats stopped, interrupted, errored, and missing sessions as unable to finish work", () => {
    expect(isSubagentSessionLive({ status: "running" })).toBe(true);
    expect(isSubagentSessionLive({ status: "ready" })).toBe(true);
    expect(isSubagentSessionLive({ status: "interrupted" })).toBe(false);
    expect(isSubagentSessionLive({ status: "stopped" })).toBe(false);
    expect(isSubagentSessionLive({ status: "error" })).toBe(false);
    expect(isSubagentSessionLive(null)).toBe(false);
  });
  it("formats elapsed time and stays empty for unreadable timestamps", () => {
    const start = "2026-09-09T10:00:00.000Z";
    const now = Date.parse("2026-09-09T10:00:42.000Z");
    expect(formatSubagentElapsed(start, null, now)).toBe("42s");
    expect(formatSubagentElapsed(start, "2026-09-09T10:05:07.000Z", now)).toBe("5m 07s");
    expect(formatSubagentElapsed(start, "2026-09-09T12:05:07.000Z", now)).toBe("2h 05m");
    expect(formatSubagentElapsed("garbage", null, now)).toBe("");
  });
  it("keeps active rows in spawn order and leads idle rows with the latest to settle", () => {
    const agent = (
      id: string,
      firstSeenAt: string,
      completedAt: string | null,
      startedAt = firstSeenAt,
    ) => ({ id, firstSeenAt, completedAt, startedAt });
    const first = agent("a", "2026-09-09T10:00:00.000Z", null);
    const second = agent("b", "2026-09-09T10:01:00.000Z", null);
    const third = agent("c", "2026-09-09T10:02:00.000Z", null);
    expect(
      [third, first, second].sort(compareSubagentsInSection("active")).map((entry) => entry.id),
    ).toEqual(["a", "b", "c"]);

    // The oldest spawn finished last, so it leads; the resumable idle agent
    // has no completion time and orders by when it started.
    const finishedLast = agent("a", "2026-09-09T10:00:00.000Z", "2026-09-09T10:10:00.000Z");
    const finishedFirst = agent("b", "2026-09-09T10:01:00.000Z", "2026-09-09T10:05:00.000Z");
    const restingIdle = agent("c", "2026-09-09T10:02:00.000Z", null, "2026-09-09T10:07:00.000Z");
    expect(
      [finishedFirst, restingIdle, finishedLast]
        .sort(compareSubagentsInSection("idle"))
        .map((entry) => entry.id),
    ).toEqual(["a", "c", "b"]);
  });
  it("nests agents and tasks under the agent that launched them", () => {
    const base = {
      kind: "subagent" as const,
      title: "",
      role: null,
      model: null,
      effort: null,
      status: "running" as const,
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: null,
      error: null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      taskType: null,
      owningAgentId: null,
      toolUseId: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-09-09T10:00:00.000Z",
    };
    const agent = (
      id: string,
      firstSeenAt: string,
      owningAgentId: string | null,
      status: (typeof base)["status"] | "completed" = "running",
    ) => ({ ...base, id, title: id, firstSeenAt, owningAgentId, status });
    const task = (id: string, firstSeenAt: string, owningAgentId: string | null) => ({
      ...base,
      kind: "background_task" as const,
      id,
      title: id,
      firstSeenAt,
      owningAgentId,
      taskType: "local_bash",
    });
    const families = buildAgentFamilies(
      [
        agent("parent", "2026-09-09T10:00:00.000Z", null, "completed"),
        agent("child", "2026-09-09T10:01:00.000Z", "parent"),
        agent("grandchild", "2026-09-09T10:02:00.000Z", "child"),
        agent("orphan", "2026-09-09T10:03:00.000Z", "gone"),
      ],
      [
        task("child-shell", "2026-09-09T10:01:30.000Z", "child"),
        task("thread-shell", "2026-09-09T10:04:00.000Z", null),
        task("lost-shell", "2026-09-09T10:05:00.000Z", "gone"),
      ],
    );
    expect(families.roots.map((node) => node.agent.id)).toEqual(["parent", "orphan"]);
    expect(
      flattenAgentFamily(families.roots[0]!).map((node) => `${node.depth}:${node.agent.id}`),
    ).toEqual(["0:parent", "1:child", "2:child-shell", "2:grandchild"]);
    expect(families.unownedTasks.map((entry) => entry.id)).toEqual(["thread-shell", "lost-shell"]);
    // The parent settled, but its family still works.
    expect(familyPanelSection(families.roots[0]!)).toBe("active");
    expect(familyPanelSection(families.roots[1]!)).toBe("active");
    const settled = buildAgentFamilies(
      [
        agent("p", "2026-09-09T10:00:00.000Z", null, "completed"),
        agent("c", "2026-09-09T10:01:00.000Z", "p", "completed"),
      ],
      [],
    );
    expect(familyPanelSection(settled.roots[0]!)).toBe("idle");
  });
  it("survives an owner cycle without dropping or looping", () => {
    const stub = (id: string, owningAgentId: string) => ({
      id,
      kind: "subagent" as const,
      title: id,
      role: null,
      model: null,
      effort: null,
      status: "running" as const,
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: null,
      error: null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      taskType: null,
      owningAgentId,
      toolUseId: null,
      firstSeenAt: "2026-09-09T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-09-09T10:00:00.000Z",
    });
    // Codex names a nested child's parent in parentAgentId, not owningAgentId.
    const codexParent = { ...stub("codex-parent", "x"), owningAgentId: null };
    const codexChild = {
      ...stub("codex-child", "x"),
      owningAgentId: null,
      parentAgentId: "codex-parent",
    };
    const codex = buildAgentFamilies([codexParent, codexChild], []);
    expect(codex.roots.map((node) => node.agent.id)).toEqual(["codex-parent"]);
    expect(codex.roots[0]!.children.map((node) => node.agent.id)).toEqual(["codex-child"]);

    const families = buildAgentFamilies([stub("a", "b"), stub("b", "a")], []);
    const ids = families.roots.flatMap((root) => flattenAgentFamily(root).map((n) => n.agent.id));
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});
