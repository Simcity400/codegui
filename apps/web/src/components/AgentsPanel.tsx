/**
 * Agents right-panel surface: the fleet view over the native subagent fold.
 * The chat carries one expandable row per spawn batch and links here.
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  isActiveSubagentStatus,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowLeft, Bot, Braces, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";

import {
  backgroundTaskTypeLabel,
  buildAgentFamilies,
  compareSubagentsInSection,
  familyPanelSection,
  flattenAgentFamily,
  formatSubagentElapsed,
  subagentActivityText,
  subagentStatusLabel,
  type AgentFamilyNode,
  type SubagentPanelSection,
} from "@t3tools/client-runtime/state/subagentPresentation";
import {
  filterWorkflowForPanelSection,
  idleAgentsOpenAtom,
  formatSubagentTitle,
  settledTasksOpenAtom,
  subagentPanelSection,
} from "./agentPanelPresentation";

const AgentTranscriptNavigation = createContext<((agent: RuntimeSubagent) => void) | null>(null);

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
/**
 * Dot colors per status; labels come from the shared presentation module so
 * mobile reads the same words. Live states all present as Working; only
 * settled states differentiate, and idle reads as settled (muted, not sky).
 */
const STATUS_DOT_CLASS: Record<RuntimeSubagent["status"], string> = {
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status])} />
  );
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  return formatSubagentElapsed(startedAt, endIso, Date.now());
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/** Stable roster row; selection opens the stored transcript without changing the fold. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const openTranscript = use(AgentTranscriptNavigation);
  const statusLabel = subagentStatusLabel(agent);
  const activity = subagentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const title = formatSubagentTitle(agent.title);
  const metadata = [
    modelLabel,
    agent.usage ? `Σ ${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "Σ — tok",
    agent.usage?.toolUses !== undefined ? `Σ ${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      disabled={!openTranscript}
      onClick={() => openTranscript?.(agent)}
      aria-label={`Open ${title} transcript`}
      className="grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left enabled:hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? statusLabel}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </button>
  );
}

/**
 * Background task row: same three-line grid as an agent row so the sections
 * read as one list, but there is no transcript to open and the metadata line
 * names the task type. A subagent's own task renders nested under it.
 */
function BackgroundTaskRow({
  task,
  ownerTitle = null,
}: {
  task: RuntimeSubagent;
  /** Set only when the owner cannot be shown by nesting (a workflow member). */
  ownerTitle?: string | null;
}) {
  const statusLabel = subagentStatusLabel(task);
  const activity = subagentActivityText(task);
  const metadata = [
    backgroundTaskTypeLabel(task.taskType),
    ownerTitle ? `via ${ownerTitle}` : null,
  ].filter((value): value is string => value !== null);
  return (
    <div className="grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left">
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={task.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{task.title}</span>
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={task} />
          {task.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          task.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? statusLabel}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
}

/**
 * One agent with everything it launched beneath it: nested subagents recurse,
 * its background tasks sit at the same level as its children. A rail marks
 * the nesting so a grandchild reads as a grandchild.
 */
function FamilyRows({ node }: { node: AgentFamilyNode }) {
  return (
    <>
      {node.agent.kind === "background_task" ? (
        <BackgroundTaskRow task={node.agent} />
      ) : (
        <AgentRow agent={node.agent} />
      )}
      {node.children.length > 0 ? (
        <div className="ml-3 border-l border-border/40 pl-1">
          {node.children.map((child) => (
            <FamilyRows key={child.agent.id} node={child} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Backgrounded shells and monitors the THREAD itself runs (a subagent's own
 * tasks nest under that subagent), split like the agent roster: live work
 * always visible, finished work behind a disclosure.
 */
function BackgroundTaskSection({
  title,
  tasks,
  ownerTitles,
  open = true,
  onToggle,
}: {
  title: "Background tasks" | "Finished tasks";
  tasks: ReadonlyArray<RuntimeSubagent>;
  ownerTitles: ReadonlyMap<string, string>;
  open?: boolean;
  onToggle?: () => void;
}) {
  if (tasks.length === 0) return null;
  const heading = (
    <>
      {onToggle ? (
        open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )
      ) : null}
      <span>{title}</span>
      <span className="font-mono font-normal text-muted-foreground/70">{tasks.length}</span>
    </>
  );
  return (
    <section
      className={cn(
        "rounded-lg border p-1.5",
        title === "Background tasks" ? "border-info/30 bg-info/5" : "border-border/60 bg-card/20",
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[.65rem] font-medium uppercase tracking-wider text-info-foreground">
          {heading}
        </div>
      )}
      {open
        ? tasks.map((task) => (
            <BackgroundTaskRow
              key={task.id}
              task={task}
              ownerTitle={
                task.owningAgentId === null ? null : (ownerTitles.get(task.owningAgentId) ?? null)
              }
            />
          ))
        : null}
    </section>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  open,
  onOpenChange,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workingCount = phase.members.filter((member) =>
    isActiveSubagentStatus(member.status),
  ).length;
  const idleCount = phase.members.filter((member) => member.status === "idle").length;
  const phaseSummary =
    phase.state === "pending" && phase.members.length === 0
      ? "pending"
      : [
          workingCount > 0 ? `${workingCount} active` : null,
          idleCount > 0 ? `${idleCount} idle` : null,
          phase.settledCount > 0 ? `${phase.settledCount} done` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ");

  return (
    <div>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">{phaseSummary}</span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? phase.members.map((member) => <AgentRow key={member.id} agent={member} />) : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
  phaseOpen,
  onPhaseOpenChange,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
  phaseOpen: (phase: AgentPanelWorkflowGroup["phases"][number]) => boolean;
  onPhaseOpenChange: (phase: AgentPanelWorkflowGroup["phases"][number], open: boolean) => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          open={phaseOpen(phase)}
          onOpenChange={(open) => onPhaseOpenChange(phase, open)}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  open,
  onOpenChange,
  phaseOpen,
  onPhaseOpenChange,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phaseOpen: (phase: AgentPanelWorkflowGroup["phases"][number]) => boolean;
  onPhaseOpenChange: (phase: AgentPanelWorkflowGroup["phases"][number], open: boolean) => void;
}) {
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => onOpenChange(false)}
      phaseOpen={phaseOpen}
      onPhaseOpenChange={onPhaseOpenChange}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => onOpenChange(true)} />
  );
}

function workflowPhaseDisclosureKey(workflowId: string, phaseIndex: number): string {
  return `${workflowId}:${phaseIndex}`;
}

function sectionAgentCount(
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>,
  families: ReadonlyArray<AgentFamilyNode>,
): number {
  return (
    families.reduce(
      (total, root) =>
        total +
        flattenAgentFamily(root).filter((node) => node.agent.kind !== "background_task").length,
      0,
    ) +
    workflows.reduce((total, group) => {
      const memberCount = workflowMembers(group).length;
      return total + (memberCount > 0 ? memberCount : 1);
    }, 0)
  );
}

function AgentRosterSection({
  title,
  workflows,
  families,
  environmentId,
  threadId,
  open = true,
  onToggle,
  workflowOpenById,
  phaseOpenByKey,
  onWorkflowOpenChange,
  onPhaseOpenChange,
}: {
  title: "Active" | "Idle";
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  families: ReadonlyArray<AgentFamilyNode>;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  open?: boolean;
  onToggle?: () => void;
  workflowOpenById: Readonly<Record<string, boolean>>;
  phaseOpenByKey: Readonly<Record<string, boolean>>;
  onWorkflowOpenChange: (workflowId: string, open: boolean) => void;
  onPhaseOpenChange: (workflowId: string, phaseIndex: number, open: boolean) => void;
}) {
  const count = sectionAgentCount(workflows, families);
  if (count === 0) return null;

  const heading = (
    <>
      {onToggle ? (
        open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )
      ) : null}
      <span>{title}</span>
      <span className="font-mono font-normal text-muted-foreground/70">{count}</span>
    </>
  );

  return (
    <section
      className={cn(
        "rounded-lg border p-1.5",
        title === "Active" ? "border-info/30 bg-info/5" : "border-border/60 bg-card/20",
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[.65rem] font-medium uppercase tracking-wider text-info-foreground">
          {heading}
        </div>
      )}
      {open ? (
        <div className="flex flex-col gap-1">
          {workflows.map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
              open={workflowOpenById[group.workflow.id] ?? workflowIsLive(group)}
              onOpenChange={(open) => onWorkflowOpenChange(group.workflow.id, open)}
              phaseOpen={(phase) =>
                phaseOpenByKey[workflowPhaseDisclosureKey(group.workflow.id, phase.index)] ??
                (phase.state === "running" || !workflowIsLive(group))
              }
              onPhaseOpenChange={(phase, open) =>
                onPhaseOpenChange(group.workflow.id, phase.index, open)
              }
            />
          ))}
          {families.length > 0 ? (
            <div>
              {workflows.length > 0 ? (
                <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground/70">
                  Direct spawns
                </div>
              ) : null}
              {families.map((node) => (
                <FamilyRows key={node.agent.id} node={node} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  renderTranscript,
  loadEarlier = null,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  /** openRoster returns from the transcript to the roster (nested spawn CTAs use it). */
  renderTranscript?: (
    agent: RuntimeSubagent,
    controls: { readonly openRoster: () => void },
  ) => ReactNode;
  /**
   * Live work is pinned to every history page by the server; settled agents
   * and tasks from older turns arrive with their page, so the roster offers
   * the same "load earlier" the transcript has.
   */
  loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const openTranscript = useCallback((agent: RuntimeSubagent) => setSelectedAgentId(agent.id), []);
  const transcriptControls = useMemo(() => ({ openRoster: () => setSelectedAgentId(null) }), []);
  const selectedAgent = useMemo(() => {
    if (selectedAgentId === null) return null;
    const directAgent = model.directAgents.find((agent) => agent.id === selectedAgentId);
    if (directAgent) return directAgent;
    for (const group of model.workflows) {
      if (group.workflow.id === selectedAgentId) return group.workflow;
      for (const phase of group.phases) {
        const member = phase.members.find((agent) => agent.id === selectedAgentId);
        if (member) return member;
      }
      const member = group.unphasedMembers.find((agent) => agent.id === selectedAgentId);
      if (member) return member;
    }
    return null;
  }, [model, selectedAgentId]);
  const idleOpenAtom = idleAgentsOpenAtom(
    environmentId && threadId ? scopedThreadKey({ environmentId, threadId }) : null,
  );
  const idleOpen = useAtomValue(idleOpenAtom);
  const setIdleOpen = useAtomSet(idleOpenAtom);
  const settledTasksOpenAtomForThread = settledTasksOpenAtom(
    environmentId && threadId ? scopedThreadKey({ environmentId, threadId }) : null,
  );
  const settledTasksOpen = useAtomValue(settledTasksOpenAtomForThread);
  const setSettledTasksOpen = useAtomSet(settledTasksOpenAtomForThread);
  const [workflowOpenById, setWorkflowOpenById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(model.workflows.map((group) => [group.workflow.id, workflowIsLive(group)])),
  );
  const [phaseOpenByKey, setPhaseOpenByKey] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      model.workflows.flatMap((group) =>
        group.phases.map((phase) => [
          workflowPhaseDisclosureKey(group.workflow.id, phase.index),
          phase.state === "running" || !workflowIsLive(group),
        ]),
      ),
    ),
  );
  const [previousWorkflows, setPreviousWorkflows] = useState(model.workflows);
  const sections = useMemo(() => {
    const workflowsIn = (section: SubagentPanelSection) => {
      const compare = compareSubagentsInSection(section);
      // A slice sorts by the row that leads it, so a mixed workflow's idle slice
      // keys on its latest settled member rather than on the still-running root.
      return model.workflows
        .flatMap((group) => {
          const slice = filterWorkflowForPanelSection(group, section);
          if (!slice) return [];
          const lead = [...workflowMembers(slice)].sort(compare)[0] ?? slice.workflow;
          return [{ slice, lead }];
        })
        .sort((a, b) => compare(a.lead, b.lead))
        .map((entry) => entry.slice);
    };
    // Direct spawns nest under whichever agent launched them, with their own
    // background tasks beneath; a family follows its liveliest member.
    const { roots, unownedTasks } = buildAgentFamilies(model.directAgents, model.backgroundTasks);
    const familiesIn = (section: SubagentPanelSection) => {
      const compare = compareSubagentsInSection(section);
      return roots
        .filter((node) => familyPanelSection(node) === section)
        .sort((a, b) => compare(a.agent, b.agent));
    };
    const tasksIn = (section: SubagentPanelSection) =>
      unownedTasks
        .filter((task) => subagentPanelSection(task.status) === section)
        .sort(compareSubagentsInSection(section));
    // Workflow members render inside their workflow group, so a task one of
    // them owns cannot nest: it stays in the thread-level list and names its
    // owner instead (mobile has no workflow groups and nests it directly).
    const workflowOwnerTitles = new Map<string, string>();
    for (const group of model.workflows) {
      workflowOwnerTitles.set(
        group.workflow.id,
        group.workflow.workflowName ?? group.workflow.title,
      );
      for (const member of workflowMembers(group)) {
        workflowOwnerTitles.set(member.id, member.title);
      }
    }
    return {
      activeWorkflows: workflowsIn("active"),
      idleWorkflows: workflowsIn("idle"),
      activeFamilies: familiesIn("active"),
      idleFamilies: familiesIn("idle"),
      activeTasks: tasksIn("active"),
      settledTasks: tasksIn("idle"),
      workflowOwnerTitles,
    };
  }, [model]);
  if (previousWorkflows !== model.workflows) {
    setPreviousWorkflows(model.workflows);
    setWorkflowOpenById((current) => {
      let next = current;
      for (const group of model.workflows) {
        if (group.workflow.id in current) continue;
        if (next === current) next = { ...current };
        next[group.workflow.id] = workflowIsLive(group);
      }
      return next;
    });

    const previousStates = new Map(
      previousWorkflows.flatMap((group) =>
        group.phases.map(
          (phase) =>
            [workflowPhaseDisclosureKey(group.workflow.id, phase.index), phase.state] as const,
        ),
      ),
    );
    setPhaseOpenByKey((current) => {
      let next = current;
      for (const group of model.workflows) {
        for (const phase of group.phases) {
          const key = workflowPhaseDisclosureKey(group.workflow.id, phase.index);
          const shouldOpen = phase.state === "running" || !workflowIsLive(group);
          if (!(key in current)) {
            if (next === current) next = { ...current };
            next[key] = shouldOpen;
          } else if (previousStates.get(key) !== "running" && phase.state === "running") {
            if (next === current) next = { ...current };
            next[key] = true;
          }
        }
      }
      return next;
    });
  }
  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents, runs a workflow, or backgrounds a task, they show up
          here with live status, activity, and token usage.
        </p>
        {loadEarlier ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={loadEarlier.loading}
            onClick={loadEarlier.onLoadEarlier}
          >
            {loadEarlier.loading ? "Loading earlier…" : "Load earlier history"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <AgentTranscriptNavigation value={renderTranscript ? openTranscript : null}>
      <div className={cn("h-full min-h-0 flex-col", selectedAgent ? "hidden" : "flex")}>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-2">
            <AgentRosterSection
              title="Active"
              workflows={sections.activeWorkflows}
              families={sections.activeFamilies}
              environmentId={environmentId}
              threadId={threadId}
              workflowOpenById={workflowOpenById}
              phaseOpenByKey={phaseOpenByKey}
              onWorkflowOpenChange={(workflowId, open) =>
                setWorkflowOpenById((current) => ({ ...current, [workflowId]: open }))
              }
              onPhaseOpenChange={(workflowId, phaseIndex, open) =>
                setPhaseOpenByKey((current) => ({
                  ...current,
                  [workflowPhaseDisclosureKey(workflowId, phaseIndex)]: open,
                }))
              }
            />
            <AgentRosterSection
              title="Idle"
              workflows={sections.idleWorkflows}
              families={sections.idleFamilies}
              environmentId={environmentId}
              threadId={threadId}
              open={idleOpen}
              onToggle={() => setIdleOpen((value) => !value)}
              workflowOpenById={workflowOpenById}
              phaseOpenByKey={phaseOpenByKey}
              onWorkflowOpenChange={(workflowId, open) =>
                setWorkflowOpenById((current) => ({ ...current, [workflowId]: open }))
              }
              onPhaseOpenChange={(workflowId, phaseIndex, open) =>
                setPhaseOpenByKey((current) => ({
                  ...current,
                  [workflowPhaseDisclosureKey(workflowId, phaseIndex)]: open,
                }))
              }
            />
            <BackgroundTaskSection
              title="Background tasks"
              tasks={sections.activeTasks}
              ownerTitles={sections.workflowOwnerTitles}
            />
            <BackgroundTaskSection
              title="Finished tasks"
              tasks={sections.settledTasks}
              ownerTitles={sections.workflowOwnerTitles}
              open={settledTasksOpen}
              onToggle={() => setSettledTasksOpen((value) => !value)}
            />
            {loadEarlier ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="self-center"
                disabled={loadEarlier.loading}
                onClick={loadEarlier.onLoadEarlier}
              >
                {loadEarlier.loading ? "Loading earlier…" : "Load earlier history"}
              </Button>
            ) : null}
          </div>
        </ScrollArea>
        <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
          <span className="flex items-center gap-2">
            {model.runningCount + model.waitingCount > 0 ? (
              <span className="text-info-foreground">
                ● {model.runningCount + model.waitingCount} working
              </span>
            ) : null}
            {model.idleCount + model.settledCount > 0 ? (
              <span>{model.idleCount + model.settledCount} idle</span>
            ) : null}
            {model.backgroundActiveCount > 0 ? (
              <span className="text-info-foreground">
                {model.backgroundActiveCount} {model.backgroundActiveCount === 1 ? "task" : "tasks"}
              </span>
            ) : null}
          </span>
          <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
        </footer>
      </div>
      {selectedAgent && renderTranscript ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <Button variant="ghost-muted" size="sm" onClick={() => setSelectedAgentId(null)}>
              <ArrowLeft aria-hidden className="size-3.5" />
              Agents
            </Button>
            <span className="truncate text-sm font-medium">{selectedAgent.title}</span>
          </div>
          {renderTranscript(selectedAgent, transcriptControls)}
        </div>
      ) : null}
    </AgentTranscriptNavigation>
  );
}
