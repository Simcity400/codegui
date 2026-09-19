import {
  buildAgentFamilies,
  compareSubagentsInSection,
  familyPanelSection,
  flattenAgentFamily,
  partitionAgentFamilies,
  subagentPanelSection,
  type AgentFamilyNode,
} from "@t3tools/client-runtime/state/subagentPresentation";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";

type AgentListRow =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      readonly count: number;
      readonly depth: number;
      readonly expanded?: boolean;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly agent: RuntimeSubagent;
      readonly depth: number;
    }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly task: RuntimeSubagent;
      readonly depth: number;
    };

/**
 * The desktop panel's sections, flattened for one list: Active and Idle
 * agent families (each agent followed by what it launched, inset per level),
 * then the thread's own live and finished background tasks.
 */
export function buildAgentListRows(
  agents: ReadonlyArray<RuntimeSubagent>,
  backgroundTasks: ReadonlyArray<RuntimeSubagent>,
  expandedSections: ReadonlySet<string>,
): AgentListRow[] {
  const rows: AgentListRow[] = [];
  const appendFamily = (node: AgentFamilyNode) => {
    rows.push(
      node.agent.kind === "background_task"
        ? { kind: "task", key: `task:${node.agent.id}`, task: node.agent, depth: node.depth }
        : { kind: "agent", key: node.agent.id, agent: node.agent, depth: node.depth },
    );
    const { active, idle } = partitionAgentFamilies(node.children);
    active.forEach(appendFamily);
    if (idle.length === 0) return;
    const key = `section:children:${node.agent.id}`;
    const expanded = expandedSections.has(key);
    rows.push({
      kind: "section",
      key,
      title: "Idle / finished",
      count: idle.reduce((count, child) => count + flattenAgentFamily(child).length, 0),
      depth: node.depth + 1,
      expanded,
    });
    if (expanded) idle.forEach(appendFamily);
  };
  const { roots, unownedTasks } = buildAgentFamilies(agents, backgroundTasks);
  for (const section of ["active", "idle"] as const) {
    const compare = compareSubagentsInSection(section);
    const families = roots
      .filter((node) => familyPanelSection(node) === section)
      .sort((a, b) => compare(a.agent, b.agent));
    const nodes = families.flatMap(flattenAgentFamily);
    const agentCount = nodes.filter((node) => node.agent.kind !== "background_task").length;
    if (agentCount === 0) continue;
    const key = `section:${section}`;
    const expanded = section === "active" || expandedSections.has(key);
    rows.push({
      kind: "section",
      key,
      title: section === "active" ? "Active" : "Idle",
      count: agentCount,
      depth: 0,
      ...(section === "idle" ? { expanded } : {}),
    });
    if (expanded) families.forEach(appendFamily);
  }
  for (const section of ["active", "idle"] as const) {
    const tasks = unownedTasks
      .filter((task) => subagentPanelSection(task.status) === section)
      .sort(compareSubagentsInSection(section));
    if (tasks.length === 0) continue;
    const key = `section:tasks:${section}`;
    const expanded = section === "active" || expandedSections.has(key);
    rows.push({
      kind: "section",
      key,
      title: section === "active" ? "Background tasks" : "Finished tasks",
      count: tasks.length,
      depth: 0,
      ...(section === "idle" ? { expanded } : {}),
    });
    if (!expanded) continue;
    for (const task of tasks) {
      rows.push({ kind: "task", key: `task:${task.id}`, task, depth: 0 });
    }
  }
  return rows;
}
