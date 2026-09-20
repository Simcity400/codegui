import type { LegendListRef } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  deriveAgentTranscriptTurn,
  selectAgentTranscript,
} from "@t3tools/client-runtime/state/agent-transcripts";
import {
  backgroundTaskTypeLabel,
  formatSubagentElapsed,
  formatSubagentTitle,
  isSubagentSessionLive,
  subagentActivityText,
  subagentStatusLabel,
} from "@t3tools/client-runtime/state/subagentPresentation";
import {
  foldThreadTasks,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { BotIcon } from "../../components/BotIcon";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { cn } from "../../lib/cn";
import { buildThreadFeed } from "../../lib/threadActivity";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useThreadDetail } from "../../state/use-thread-detail";
import { useEnvironmentThread } from "../../state/threads";
import { useProject } from "../../state/entities";
import { ThreadFeed } from "../threads/ThreadFeed";
import { projectThreadContentPresentation } from "../threads/threadContentPresentation";

import { buildAgentListRows } from "./agentListRows";

type ThreadParams = { readonly environmentId: string; readonly threadId: string };

function useAgentThread(params: ThreadParams) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const state = useThreadDetail({ environmentId, threadId });
  const thread = Option.getOrNull(state.data);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const workspaceRoot = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const activities = thread?.activities;
  // Shared with desktop so the same thread never reads live here and stopped there.
  const sessionLive = isSubagentSessionLive(thread?.session);
  const { agents, backgroundTasks } = useMemo(
    () => foldThreadTasks(activities ?? [], { sessionLive }),
    [activities, sessionLive],
  );
  const presentation = projectThreadContentPresentation({
    hasDetail: thread !== null,
    detailError: Option.getOrNull(state.error),
    detailDeleted: state.status === "deleted",
    connectionState: runtime?.connectionState ?? "available",
  });
  const loadEarlier = threadHasOlderTurns(state)
    ? {
        cursor: Option.getOrNull(state.page)?.beforeCursor ?? null,
        loading: Option.isSome(state.page) && state.page.value.loadingOlder,
        onLoadEarlier: () => requestOlderThreadTurns(environmentId, threadId),
      }
    : null;
  return {
    environmentId,
    threadId,
    thread,
    agents,
    backgroundTasks,
    presentation,
    loadEarlier,
    workspaceRoot,
  };
}

const AGENT_STATUS_DOT_CLASS: Record<RuntimeSubagent["status"], string> = {
  pending: "bg-adaptive-sky-600-400",
  running: "bg-adaptive-sky-600-400",
  waiting: "bg-adaptive-sky-600-400",
  idle: "bg-foreground-muted",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  cancelled: "bg-foreground-muted",
  interrupted: "bg-foreground-muted",
};

/** Elapsed time of the current activation; live rows tick once a second. */
function AgentElapsed({ agent }: { readonly agent: RuntimeSubagent }) {
  const live = agent.status === "running" || agent.status === "waiting";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (!agent.startedAt) return null;
  return (
    <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
      {formatSubagentElapsed(agent.startedAt, live ? null : agent.completedAt, now)}
    </Text>
  );
}

/** Nested launches inset per level so a grandchild reads as a grandchild. */
const NEST_INSET = 14;

/** Mirrors the desktop roster row: dot, title, elapsed, activity, metadata. */
const AgentRow = memo(function AgentRow(props: {
  readonly agent: RuntimeSubagent;
  readonly depth: number;
  readonly onPress: (agent: RuntimeSubagent) => void;
}) {
  const { agent } = props;
  const title = formatSubagentTitle(agent.title);
  const statusLabel = subagentStatusLabel(agent);
  const activity = subagentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const metadata = [
    modelLabel,
    agent.usage ? `Σ ${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "Σ — tok",
    agent.usage?.toolUses !== undefined ? `Σ ${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title} transcript, ${statusLabel}`}
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 active:bg-subtle"
      style={props.depth > 0 ? { marginLeft: props.depth * NEST_INSET } : undefined}
      onPress={() => props.onPress(agent)}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              AGENT_STATUS_DOT_CLASS[agent.status],
            )}
          />
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
            {title}
          </Text>
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <SymbolView name="checkmark" size={11} tintColorClassName="accent-icon" />
          ) : null}
        </View>
        <Text
          className={cn(
            "pl-3.5 text-xs",
            agent.status === "failed" ? "text-adaptive-rose-600-400" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {activity ?? statusLabel}
        </Text>
        <Text
          className="pl-3.5 font-mono text-2xs tabular-nums text-foreground-muted"
          numberOfLines={1}
        >
          {metadata.join(" · ")}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
});

/** Mirrors the desktop background task row: no transcript, task type as metadata. */
const BackgroundTaskRow = memo(function BackgroundTaskRow(props: {
  readonly task: RuntimeSubagent;
  readonly depth: number;
}) {
  const { task } = props;
  const statusLabel = subagentStatusLabel(task);
  const activity = subagentActivityText(task);
  const metadata = [backgroundTaskTypeLabel(task.taskType)];
  return (
    <View
      accessibilityLabel={`${task.title}, ${statusLabel}`}
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
      style={props.depth > 0 ? { marginLeft: props.depth * NEST_INSET } : undefined}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <View
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", AGENT_STATUS_DOT_CLASS[task.status])}
          />
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
            {task.title}
          </Text>
          <AgentElapsed agent={task} />
          {task.status === "completed" ? (
            <SymbolView name="checkmark" size={11} tintColorClassName="accent-icon" />
          ) : null}
        </View>
        <Text
          className={cn(
            "pl-3.5 text-xs",
            task.status === "failed" ? "text-adaptive-rose-600-400" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {activity ?? statusLabel}
        </Text>
        <Text
          className="pl-3.5 font-mono text-2xs tabular-nums text-foreground-muted"
          numberOfLines={1}
        >
          {metadata.join(" · ")}
        </Text>
      </View>
    </View>
  );
});

export function ThreadAgentsRouteScreen(props: StaticScreenProps<ThreadParams>) {
  const navigation = useNavigation();
  const { environmentId, threadId, agents, backgroundTasks, presentation, loadEarlier } =
    useAgentThread(props.route.params);
  const insets = useSafeAreaInsets();
  const historyRequest = useRef<{ key: string | null; size: number }>({ key: null, size: 0 });
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<string>>(() => new Set());
  const sectionScope = `${environmentId}:${threadId}:`;
  const rows = useMemo(
    () =>
      buildAgentListRows(
        agents,
        backgroundTasks,
        new Set(
          [...expandedSections]
            .filter((key) => key.startsWith(sectionScope))
            .map((key) => key.slice(sectionScope.length)),
        ),
      ),
    [agents, backgroundTasks, expandedSections, sectionScope],
  );
  const toggleSection = (key: string) => {
    const scopedKey = `${sectionScope}${key}`;
    setExpandedSections((previous) => {
      const next = new Set(previous);
      if (next.has(scopedKey)) next.delete(scopedKey);
      else next.add(scopedKey);
      return next;
    });
  };
  const rosterSize = agents.length + backgroundTasks.length;
  const openTranscript = useCallback(
    (agent: RuntimeSubagent) =>
      navigation.navigate("ThreadAgentTranscript", { ...props.route.params, agentId: agent.id }),
    [navigation, props.route.params],
  );

  // Parent history pages may contain no agents, leaving the list too short to reach its edge again.
  useEffect(() => {
    if (rosterSize !== historyRequest.current.size || !loadEarlier || loadEarlier.loading) return;
    const key = `${environmentId}:${threadId}:${loadEarlier.cursor}`;
    if (historyRequest.current.key === key) return;
    historyRequest.current = { key, size: rosterSize };
    loadEarlier.onLoadEarlier();
  }, [rosterSize, environmentId, threadId, loadEarlier]);

  if (presentation.kind === "loading") return <LoadingScreen message="Loading agents…" />;
  if (presentation.kind === "unavailable") {
    return <EmptyState title={presentation.title} detail={presentation.detail} />;
  }

  return (
    <FlatList
      className="flex-1 bg-screen"
      data={rows}
      keyExtractor={(row) => row.key}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 8 }}
      renderItem={({ item }) =>
        item.kind === "section" ? (
          <Pressable
            disabled={item.expanded === undefined}
            accessibilityRole={item.expanded === undefined ? "header" : "button"}
            accessibilityState={
              item.expanded === undefined ? undefined : { expanded: item.expanded }
            }
            onPress={() => toggleSection(item.key)}
            className="flex-row items-center gap-1.5 px-1 py-2"
            style={item.depth > 0 ? { marginLeft: item.depth * NEST_INSET } : undefined}
          >
            {item.expanded === undefined ? (
              <BotIcon size={12} colorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name={item.expanded ? "chevron.down" : "chevron.right"}
                size={12}
                tintColorClassName="accent-icon-muted"
              />
            )}
            <Text className="text-2xs font-t3-medium uppercase tracking-wider text-foreground-muted">
              {item.title}
            </Text>
            <Text className="font-mono text-2xs text-foreground-muted">{item.count}</Text>
          </Pressable>
        ) : item.kind === "task" ? (
          <BackgroundTaskRow task={item.task} depth={item.depth} />
        ) : (
          <AgentRow agent={item.agent} depth={item.depth} onPress={openTranscript} />
        )
      }
      ListEmptyComponent={
        <EmptyState
          title="No agents yet"
          detail="Subagents and background tasks will appear here when the provider reports them."
        />
      }
      onEndReached={() => {
        if (loadEarlier && !loadEarlier.loading) {
          historyRequest.current = {
            key: `${environmentId}:${threadId}:${loadEarlier.cursor}`,
            size: rosterSize,
          };
          loadEarlier.onLoadEarlier();
        }
      }}
      onEndReachedThreshold={0.25}
    />
  );
}

export function ThreadAgentTranscriptRouteScreen(
  props: StaticScreenProps<ThreadParams & { readonly agentId: string }>,
) {
  const { environmentId, threadId, agents, workspaceRoot } = useAgentThread(props.route.params);
  const agentId = props.route.params.agentId;
  const agent = agents.find((entry) => entry.id === agentId);
  // Agents stream on the root thread, so the transcript reads there instead
  // of opening a second full subscription.
  const scopedState = useEnvironmentThread(environmentId, threadId);
  const scopedThread = Option.getOrNull(scopedState.data);
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const presentation = projectThreadContentPresentation({
    hasDetail: scopedThread !== null,
    detailError: Option.getOrNull(scopedState.error),
    detailDeleted: scopedState.status === "deleted",
    connectionState: runtime?.connectionState ?? "available",
  });
  const loadEarlier = threadHasOlderTurns(scopedState)
    ? {
        loading: Option.isSome(scopedState.page) && scopedState.page.value.loadingOlder,
        onLoadEarlier: () => requestOlderThreadTurns(environmentId, threadId),
      }
    : null;
  const messages = scopedThread?.messages;
  const activities = scopedThread?.activities;
  const scoped = useMemo(
    () => selectAgentTranscript(messages ?? [], activities ?? [], agentId),
    [messages, activities, agentId],
  );
  const feed = useMemo(() => buildThreadFeed(scoped), [scoped]);
  const turn = useMemo(() => deriveAgentTranscriptTurn(scoped, agent), [scoped, agent]);
  const listRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom + 16 }}>
      <NativeStackScreenOptions options={{ title: agent?.title ?? "Agent transcript" }} />
      <ThreadFeed
        key={agentId}
        environmentId={environmentId}
        threadId={threadId}
        workspaceRoot={workspaceRoot}
        feed={feed}
        queuedMessages={[]}
        dispatchingMessageId={null}
        onEditPendingMessage={() => undefined}
        contentPresentation={presentation}
        agentLabel={agent?.title ?? "Agent"}
        latestTurn={turn.latestTurn}
        activeWorkStartedAt={turn.activeTurnStartedAt}
        listRef={listRef}
        freeze={freeze}
        anchorMessageId={null}
        submittedMessageId={null}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        contentTopInset={0}
        contentBottomInset={0}
        loadEarlier={loadEarlier}
      />
    </View>
  );
}
