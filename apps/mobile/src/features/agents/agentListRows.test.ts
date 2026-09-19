import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { buildAgentListRows } from "./agentListRows";

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

function agent(
  id: string,
  owningAgentId: string | null,
  status: RuntimeSubagent["status"] = "running",
): RuntimeSubagent {
  return { ...base, id, title: id, owningAgentId, status, firstSeenAt: "2026-09-09T10:00:00.000Z" };
}
function task(
  id: string,
  owningAgentId: string | null,
  status: RuntimeSubagent["status"] = "running",
): RuntimeSubagent {
  return { ...agent(id, owningAgentId, status), kind: "background_task", taskType: "shell" };
}
const agents = [
  agent("parent", null),
  agent("child", "parent", "completed"),
  agent("grandchild", "child", "waiting"),
  agent("idle-child", "parent", "idle"),
  agent("old-root", null, "completed"),
];
const tasks = [
  task("live-shell", "parent"),
  task("done-shell", "parent", "completed"),
  task("failed-shell", "child", "failed"),
  task("thread-shell", null),
  task("old-shell", null, "interrupted"),
];
const visibleKeys = (expanded: ReadonlySet<string> = new Set(), roster = agents) =>
  buildAgentListRows(roster, tasks, expanded)
    .filter((row) => row.kind !== "section")
    .map((row) => row.key);

describe("agent list disclosures", () => {
  it("hides settled work by default while preserving the path to active grandchildren", () => {
    expect(visibleKeys()).toEqual([
      "parent",
      "child",
      "grandchild",
      "task:live-shell",
      "task:thread-shell",
    ]);
    const rows = buildAgentListRows(agents, tasks, new Set());
    expect(rows.find((row) => row.key === "section:children:parent")).toMatchObject({
      count: 2,
      depth: 1,
      expanded: false,
    });
    expect(rows.find((row) => row.key === "section:children:child")).toMatchObject({
      count: 1,
      depth: 2,
      expanded: false,
    });
  });
  it("opens each owner's history independently and allows it to close again", () => {
    const expanded = new Set(["section:children:parent"]);
    expect(visibleKeys(expanded)).toContain("idle-child");
    expect(visibleKeys(expanded)).toContain("task:done-shell");
    expect(visibleKeys(expanded)).not.toContain("task:failed-shell");
    expanded.add("section:children:child");
    expect(visibleKeys(expanded)).toContain("task:failed-shell");
    expanded.delete("section:children:parent");
    expect(visibleKeys(expanded)).not.toContain("idle-child");
    expect(visibleKeys(expanded)).toContain("task:failed-shell");
  });
  it("reveals a resumed child even when its history remains collapsed", () => {
    const resumed = agents.map((entry) =>
      entry.id === "idle-child" ? { ...entry, status: "running" as const } : entry,
    );
    expect(visibleKeys(new Set(), resumed)).toContain("idle-child");
  });
  it("makes top-level idle agents and finished tasks available on demand", () => {
    expect(visibleKeys(new Set(["section:idle", "section:tasks:idle"]))).toEqual([
      "parent",
      "child",
      "grandchild",
      "task:live-shell",
      "old-root",
      "task:thread-shell",
      "task:old-shell",
    ]);
  });
  it("moves a fully settled family into the collapsed idle section", () => {
    const settled = agents.map((entry) => ({ ...entry, status: "completed" as const }));
    const finished = tasks.map((entry) => ({ ...entry, status: "completed" as const }));
    expect(buildAgentListRows(settled, finished, new Set()).map((row) => row.key)).toEqual([
      "section:idle",
      "section:tasks:idle",
    ]);
  });
});
