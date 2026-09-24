import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  foldThreadTasks,
} from "./subagentRuntime.ts";

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("foldSubagentActivities", () => {
  it("a fresh start after settling is a resume (Claude SendMessage re-emits task_started)", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "ae355",
        taskType: "local_agent",
        title: "Ladder builder",
        toolUseId: "toolu_launch",
      }),
      activity("task.updated", { taskId: "ae355", status: "completed", toolUseId: "toolu_launch" }),
      activity("task.completed", {
        taskId: "ae355",
        status: "completed",
        summary: "Built the ladder",
        toolUseId: "toolu_launch",
      }),
      // Wire-confirmed: the resume arrives as task_started on the SAME task id
      // under the SendMessage tool use, then progress under that id.
      activity("task.started", {
        taskId: "ae355",
        taskType: "local_agent",
        title: "Ladder builder",
        toolUseId: "toolu_send_message",
      }),
      activity("task.progress", {
        taskId: "ae355",
        summary: "Adding the gap_diff rung",
        toolUseId: "toolu_send_message",
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.status).toBe("running");
    expect(agent.activationCount).toBe(2);
    expect(agent.result).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.toolUseId).toBe("toolu_send_message");
    expect(agent.progress).toBe("Adding the gap_diff rung");
  });

  it("a start without tool attribution after settling is a replay, not a resume", () => {
    // Codex re-registers a known child from thread/started and subAgentActivity
    // without a tool use; its real resume arrives as task.updated running.
    const agents = fold([
      activity("task.started", { taskId: "child", title: "Marlow" }),
      activity("task.updated", { taskId: "child", status: "interrupted" }),
      activity("task.started", { taskId: "child", title: "Marlow" }),
    ]);
    expect(agents[0]!.status).toBe("interrupted");
    expect(agents[0]!.activationCount).toBe(1);
    const resumed = fold([
      activity("task.started", { taskId: "child", title: "Marlow" }),
      activity("task.updated", { taskId: "child", status: "interrupted" }),
      activity("task.updated", { taskId: "child", status: "running" }),
    ]);
    expect(resumed[0]!.status).toBe("running");
    expect(resumed[0]!.activationCount).toBe(2);
  });
});

describe("session-derived interruption", () => {
  it.each(["runtime.error", "session.reset"])(
    "does not resurrect orphaned agents after %s when a new session runs",
    (kind) => {
      const rows = [
        activity("task.started", { taskId: "orphan", taskType: "local_agent" }),
        activity("task.started", { taskId: "resumed", taskType: "local_agent" }),
        activity("task.started", { taskId: "shell", taskType: "local_bash", isBackgrounded: true }),
        activity("task.updated", { taskId: "idle", status: "idle" }),
        activity("task.completed", { taskId: "done", status: "completed" }),
        activity(kind, {}),
        activity("task.progress", {
          taskId: "orphan",
          usageSnapshot: true,
          typedUsage: { totalTokens: 42 },
        }),
        activity("task.updated", { taskId: "resumed", status: "running" }),
        activity("task.started", { taskId: "new", taskType: "local_agent" }),
      ];
      const { agents, backgroundTasks } = foldThreadTasks(rows, { sessionLive: true });
      expect(agents.find((agent) => agent.id === "orphan")).toMatchObject({
        status: "interrupted",
        usage: { totalTokens: 42 },
      });
      expect(agents.find((agent) => agent.id === "resumed")).toMatchObject({
        status: "running",
        activationCount: 2,
      });
      expect(agents.find((agent) => agent.id === "new")?.status).toBe("running");
      expect(agents.find((agent) => agent.id === "idle")?.status).toBe("idle");
      expect(agents.find((agent) => agent.id === "done")?.status).toBe("completed");
      expect(backgroundTasks[0]?.status).toBe("interrupted");
    },
  );
});

describe("background task roster", () => {
  it("lists backgrounded shells and monitors with their lifecycle, never foreground shells", () => {
    const { agents, backgroundTasks } = foldThreadTasks([
      activity("task.started", {
        taskId: "bg-shell",
        taskType: "local_bash",
        title: "Run full gates",
        isBackgrounded: true,
        toolUseId: "toolu_bash_1",
      }),
      activity("task.started", {
        taskId: "fg-shell",
        taskType: "local_bash",
        title: "List files",
        isBackgrounded: false,
      }),
      activity("task.completed", { taskId: "fg-shell", status: "completed" }),
      activity("task.started", { taskId: "watch", taskType: "monitor", title: "Watch CI" }),
      activity("task.started", { taskId: "plan-1", taskType: "plan", isBackgrounded: true }),
      activity("task.started", { taskId: "agent-1", taskType: "local_agent", title: "Agent" }),
      activity("task.updated", {
        taskId: "bg-shell",
        status: "completed",
        endedAt: "2026-08-01T12:00:00.000Z",
      }),
      activity("task.completed", {
        taskId: "bg-shell",
        status: "completed",
        summary: 'Background command "Run full gates" completed (exit code 0)',
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
    expect(backgroundTasks.map((task) => task.id).sort()).toEqual(["bg-shell", "watch"]);
    const shell = backgroundTasks.find((task) => task.id === "bg-shell")!;
    expect(shell.kind).toBe("background_task");
    expect(shell.status).toBe("completed");
    expect(shell.taskType).toBe("local_bash");
    expect(shell.completedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(shell.result).toContain("exit code 0");
    expect(backgroundTasks.find((task) => task.id === "watch")!.status).toBe("running");
  });

  it("a foreground shell backgrounded by a later patch joins the roster with its history", () => {
    const { backgroundTasks } = foldThreadTasks([
      activity("task.started", {
        taskId: "shell",
        taskType: "local_bash",
        title: "Long build",
        isBackgrounded: false,
      }),
      activity("task.updated", { taskId: "shell", isBackgrounded: true }),
    ]);
    expect(backgroundTasks).toHaveLength(1);
    expect(backgroundTasks[0]!.status).toBe("running");
    expect(backgroundTasks[0]!.activationCount).toBe(1);
  });

  it("a subagent-owned background shell keeps its owner and stays out of the agent roster", () => {
    const { agents, backgroundTasks } = foldThreadTasks([
      activity("task.started", { taskId: "owner", taskType: "local_agent", title: "Owner" }),
      activity("task.started", {
        taskId: "inner-shell",
        taskType: "local_bash",
        agentId: "owner",
        isBackgrounded: true,
        title: "Inner watch",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["owner"]);
    expect(backgroundTasks[0]!.owningAgentId).toBe("owner");
  });

  it("session death interrupts live background tasks too", () => {
    const rows = [
      activity("task.started", { taskId: "bg", taskType: "local_bash", isBackgrounded: true }),
    ];
    expect(foldThreadTasks(rows, { sessionLive: false }).backgroundTasks[0]!.status).toBe(
      "interrupted",
    );
    expect(foldThreadTasks(rows, { sessionLive: true }).backgroundTasks[0]!.status).toBe("running");
  });

  it("the panel model carries background tasks without touching agent counts", () => {
    const { agents, backgroundTasks } = foldThreadTasks([
      activity("task.started", { taskId: "a", taskType: "local_agent" }),
      activity("task.started", { taskId: "bg-1", taskType: "local_bash", isBackgrounded: true }),
      activity("task.started", { taskId: "bg-2", taskType: "local_bash", isBackgrounded: true }),
      activity("task.completed", { taskId: "bg-2", status: "completed" }),
    ]);
    const model = deriveAgentPanelModel({ agents, backgroundTasks });
    expect(model.runningCount).toBe(1);
    expect(model.liveCount).toBe(1);
    expect(model.settledCount).toBe(0);
    expect(model.backgroundTasks.map((task) => task.id)).toEqual(["bg-1", "bg-2"]);
    expect(model.backgroundActiveCount).toBe(1);
    // Background work alone still gives the surface something to render.
    const tasksOnly = deriveAgentPanelModel({ agents: [], backgroundTasks });
    expect(tasksOnly.hasAgents).toBe(true);
    expect(tasksOnly.liveCount).toBe(0);
  });
});
