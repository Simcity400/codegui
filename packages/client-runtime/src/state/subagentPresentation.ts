import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "./subagentRuntime.ts";

/**
 * Presentation rules shared by the desktop Agents panel and the mobile Agents
 * screen, so a subagent reads the same on every client.
 */

export type SubagentPanelSection = "active" | "idle";

export function subagentPanelSection(status: RuntimeSubagentStatus): SubagentPanelSection {
  return isActiveSubagentStatus(status) ? "active" : "idle";
}

/**
 * Live states all read as "Working" (monitoring-pill design: detail belongs in
 * the activity line, and a waiting or queued subagent is still the fleet doing
 * its job). Only settled states differentiate. Idle reads as settled because a
 * resting Codex child looks done unless resumed.
 */
const SUBAGENT_STATUS_LABEL: Record<RuntimeSubagentStatus, string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

/** Background tasks are not a fleet: a live shell is simply running. */
const BACKGROUND_TASK_STATUS_LABEL: Record<RuntimeSubagentStatus, string> = {
  pending: "Running",
  running: "Running",
  waiting: "Running",
  idle: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export function subagentStatusLabel(agent: Pick<RuntimeSubagent, "kind" | "status">): string {
  if (agent.kind === "background_task") return BACKGROUND_TASK_STATUS_LABEL[agent.status];
  return agent.kind === "subagent_batch" && agent.status === "idle"
    ? "Idle"
    : SUBAGENT_STATUS_LABEL[agent.status];
}

const BACKGROUND_TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  local_bash: "Shell",
  shell: "Shell",
  monitor: "Monitor",
  monitor_mcp: "Monitor",
};

/** Human label for a background task's provider type; unknown types pass through. */
export function backgroundTaskTypeLabel(taskType: string | null): string {
  if (taskType === null) return "Task";
  return BACKGROUND_TASK_TYPE_LABEL[taskType] ?? formatSubagentTitle(taskType);
}

/**
 * Whether the provider session can still finish background work. Shared by
 * every client so the same thread never reads as running on one device and
 * stopped on another: a missing, stopped, interrupted, or errored session
 * has no process left to settle its tasks.
 */
export function isSubagentSessionLive(
  session: { readonly status: string } | null | undefined,
): boolean {
  return (
    session != null &&
    session.status !== "stopped" &&
    session.status !== "interrupted" &&
    session.status !== "error"
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
export function subagentActivityText(
  agent: Pick<RuntimeSubagent, "status" | "progress" | "lastToolName" | "result" | "error">,
): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  const tool = agent.lastToolName ? `▸ ${agent.lastToolName}` : null;
  if (live) {
    return agent.progress ?? tool ?? agent.result ?? agent.error;
  }
  return agent.error ?? agent.result ?? agent.progress ?? tool;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time of one activation; empty when either timestamp is unreadable. */
export function formatSubagentElapsed(
  startedAt: string,
  endedAt: string | null,
  now: number,
): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

const SUBAGENT_TITLE_TERMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  claude: "Claude",
  cli: "CLI",
  codex: "Codex",
  css: "CSS",
  e2e: "E2E",
  expo: "Expo",
  git: "Git",
  github: "GitHub",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  ios: "iOS",
  ipad: "iPad",
  iphone: "iPhone",
  js: "JS",
  json: "JSON",
  macos: "macOS",
  mcp: "MCP",
  pr: "PR",
  qa: "QA",
  sdk: "SDK",
  sql: "SQL",
  ssh: "SSH",
  t3: "T3",
  ts: "TS",
  ui: "UI",
  url: "URL",
  ux: "UX",
  ws: "WS",
  xcode: "Xcode",
  xml: "XML",
};

/**
 * Makes provider task keys pleasant to read without changing the stable key
 * used for transcript attribution. Explicit human-written titles are kept as
 * provided; only lowercase identifier-shaped titles are humanized.
 */
export function formatSubagentTitle(title: string): string {
  const trimmed = title.trim();
  if (
    trimmed.length === 0 ||
    !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(trimmed)
  ) {
    return trimmed;
  }

  return trimmed
    .split(/[_-]+/)
    .map((part, index) => {
      const knownTerm = Object.hasOwn(SUBAGENT_TITLE_TERMS, part)
        ? SUBAGENT_TITLE_TERMS[part]
        : undefined;
      if (knownTerm) return knownTerm;
      return index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
    })
    .join(" ");
}

export interface AgentFamilyNode {
  /** An agent, or one of its background tasks (kind "background_task"). */
  readonly agent: RuntimeSubagent;
  readonly depth: number;
  readonly children: ReadonlyArray<AgentFamilyNode>;
}

export interface AgentFamilies {
  /** Agents nobody in the roster launched, each with its nested launches beneath it. */
  readonly roots: ReadonlyArray<AgentFamilyNode>;
  /** Background tasks whose owner is the thread itself or is not in the roster. */
  readonly unownedTasks: ReadonlyArray<RuntimeSubagent>;
}

const FAMILY_DEPTH_LIMIT = 8;

/**
 * Nests every agent under the agent that launched it (owningAgentId) and
 * files an agent's own background tasks beneath it, so the roster shows
 * which subagent spawned which, and whose shells are still running. Owners
 * missing from the roster (aged out, other provider) make their children
 * roots and their tasks unowned rather than hiding anything. Children keep
 * spawn order.
 */
export function buildAgentFamilies(
  agents: ReadonlyArray<RuntimeSubagent>,
  backgroundTasks: ReadonlyArray<RuntimeSubagent>,
): AgentFamilies {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childAgents = new Map<string, RuntimeSubagent[]>();
  const roots: RuntimeSubagent[] = [];
  for (const agent of agents) {
    // Claude names the launching agent in owningAgentId; Codex names a nested
    // child's parent thread in parentAgentId. Either nests the agent when that
    // parent is itself in this roster (a workflow coordinator is not: its
    // members render in the workflow group instead).
    const owner = agent.owningAgentId ?? agent.parentAgentId;
    if (owner !== null && owner !== agent.id && byId.has(owner)) {
      const list = childAgents.get(owner) ?? [];
      list.push(agent);
      childAgents.set(owner, list);
    } else {
      roots.push(agent);
    }
  }
  const ownedTasks = new Map<string, RuntimeSubagent[]>();
  const unownedTasks: RuntimeSubagent[] = [];
  for (const task of backgroundTasks) {
    const owner = task.owningAgentId;
    if (owner !== null && byId.has(owner)) {
      const list = ownedTasks.get(owner) ?? [];
      list.push(task);
      ownedTasks.set(owner, list);
    } else {
      unownedTasks.push(task);
    }
  }
  const bySpawn = (a: RuntimeSubagent, b: RuntimeSubagent) =>
    a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);
  // Visited guard: a malformed owner cycle must render as roots, never recurse.
  const visited = new Set<string>();
  const build = (agent: RuntimeSubagent, depth: number): AgentFamilyNode => {
    visited.add(agent.id);
    const children: AgentFamilyNode[] = [];
    if (depth < FAMILY_DEPTH_LIMIT) {
      for (const child of [...(childAgents.get(agent.id) ?? [])].sort(bySpawn)) {
        if (!visited.has(child.id)) children.push(build(child, depth + 1));
      }
      for (const task of [...(ownedTasks.get(agent.id) ?? [])].sort(bySpawn)) {
        children.push({ agent: task, depth: depth + 1, children: [] });
      }
      children.sort((a, b) => bySpawn(a.agent, b.agent));
    }
    return { agent, depth, children };
  };
  const rootNodes = roots.sort(bySpawn).map((agent) => build(agent, 0));
  // An agent whose owner sits inside a cycle is reachable from no root.
  for (const agent of agents) {
    if (!visited.has(agent.id)) rootNodes.push(build(agent, 0));
  }
  return { roots: rootNodes, unownedTasks };
}

/**
 * A family belongs to the Active section while any member still works: a
 * parent that finished but whose child (or shell) is still running has not
 * really settled from the user's point of view.
 */
export function familyPanelSection(node: AgentFamilyNode): SubagentPanelSection {
  if (isActiveSubagentStatus(node.agent.status)) return "active";
  return node.children.some((child) => familyPanelSection(child) === "active") ? "active" : "idle";
}

/** Depth-first flattening for list renderers (mobile FlatList, counts). */
export function flattenAgentFamily(node: AgentFamilyNode): ReadonlyArray<AgentFamilyNode> {
  return [node, ...node.children.flatMap(flattenAgentFamily)];
}

/**
 * Row order inside a panel section. Active rows keep spawn order so a newly
 * launched agent joins at the bottom; idle rows lead with whichever agent
 * settled most recently so the top of that section is always the latest result.
 * Only first-write timestamps take part, so a visible row never reshuffles on
 * progress events: a resumable idle agent has no completion time and orders by
 * when it started instead.
 */
export function compareSubagentsInSection(
  section: SubagentPanelSection,
): (
  a: Pick<RuntimeSubagent, "id" | "firstSeenAt" | "startedAt" | "completedAt">,
  b: Pick<RuntimeSubagent, "id" | "firstSeenAt" | "startedAt" | "completedAt">,
) => number {
  if (section === "active") {
    return (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);
  }
  const settledAt = (agent: Pick<RuntimeSubagent, "firstSeenAt" | "startedAt" | "completedAt">) =>
    agent.completedAt ?? agent.startedAt ?? agent.firstSeenAt;
  return (a, b) =>
    settledAt(b).localeCompare(settledAt(a)) ||
    b.firstSeenAt.localeCompare(a.firstSeenAt) ||
    a.id.localeCompare(b.id);
}
