import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type AgentPanelWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  subagentPanelSection,
  type SubagentPanelSection,
} from "@t3tools/client-runtime/state/subagentPresentation";
import { Atom } from "effect/unstable/reactivity";

export {
  formatSubagentTitle,
  subagentPanelSection,
} from "@t3tools/client-runtime/state/subagentPresentation";

// Preserve each thread's disclosure choice when switching panel surfaces.
export const idleAgentsOpenAtom = Atom.family((_threadKey: string | null) =>
  Atom.make(true).pipe(Atom.keepAlive),
);
// Finished background tasks are history: closed by default so live work stays in view.
export const settledTasksOpenAtom = Atom.family((_threadKey: string | null) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

function workflowSliceStatus(
  members: ReadonlyArray<RuntimeSubagent>,
  section: SubagentPanelSection,
): RuntimeSubagent["status"] {
  if (section === "active") {
    if (members.some((member) => member.status === "running")) return "running";
    if (members.some((member) => member.status === "waiting")) return "waiting";
    return "pending";
  }
  if (members.some((member) => member.status === "failed")) return "failed";
  if (members.some((member) => member.status === "idle")) return "idle";
  if (members.some((member) => member.status === "interrupted")) return "interrupted";
  if (members.some((member) => member.status === "cancelled")) return "cancelled";
  return "completed";
}

/**
 * Projects one workflow into a panel section without flattening its phase
 * shape. A mixed workflow can therefore appear in both sections while every
 * individual member remains hideable under the correct disclosure.
 */
export function filterWorkflowForPanelSection(
  group: AgentPanelWorkflowGroup,
  section: SubagentPanelSection,
): AgentPanelWorkflowGroup | null {
  const allMembers = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  if (allMembers.length === 0) {
    return subagentPanelSection(group.workflow.status) === section ? group : null;
  }

  const phases = group.phases.flatMap<AgentPanelWorkflowGroup["phases"][number]>((phase) => {
    const members = phase.members.filter(
      (member) => subagentPanelSection(member.status) === section,
    );
    if (members.length === 0) return [];
    const activeCount = members.filter(
      (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
    ).length;
    const settledCount = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
    return [
      {
        ...phase,
        members,
        state: activeCount > 0 ? "running" : settledCount === members.length ? "done" : "pending",
        activeCount,
        settledCount,
      },
    ];
  });
  const unphasedMembers = group.unphasedMembers.filter(
    (member) => subagentPanelSection(member.status) === section,
  );
  const members = [...phases.flatMap((phase) => phase.members), ...unphasedMembers];
  if (members.length === 0) return null;

  return {
    ...group,
    workflow: { ...group.workflow, status: workflowSliceStatus(members, section) },
    phases,
    unphasedMembers,
  };
}
