import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable } from "react-native";
import * as Option from "effect/Option";
import type { CodexGoalSetInput, OrchestrationThreadGoal } from "@t3tools/contracts";
import {
  codexGoalSessionActivity,
  codexGoalStatusAction,
  formatCodexGoalDescription,
  formatCodexGoalError,
  formatCodexGoalStatus,
  formatCodexGoalUsageCompact,
  parseCodexGoalCommand,
  toCodexGoalSetInput,
} from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { cn } from "../../lib/cn";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { CodexGoalEditorModal, type CodexGoalEditorSubmission } from "./CodexGoalEditorModal";
import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";

export function useCodexGoalControls(
  props: Pick<
    ThreadDetailScreenProps,
    "environmentId" | "selectedThread" | "serverConfig" | "showContent"
  >,
) {
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const showContent = props.showContent ?? true;
  const setCodexGoal = useAtomCommand(threadEnvironment.setCodexGoal, { reportFailure: false });
  const clearCodexGoal = useAtomCommand(threadEnvironment.clearCodexGoal, { reportFailure: false });
  const selectedProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === selectedInstanceId,
  );
  // The goal is projected from Codex's notifications onto the thread detail,
  // so it stays visible while the provider session is stopped. Same atom the
  // route screen already subscribes to for the feed.
  const environmentThread = Option.getOrNull(
    useEnvironmentThread(props.environmentId, props.selectedThread.id).data,
  );
  const codexGoal = selectedProvider?.driver === "codex" ? (environmentThread?.goal ?? null) : null;
  const codexGoalActivity = codexGoalSessionActivity(props.selectedThread.session);
  const [codexGoalEditorOpen, setCodexGoalEditorOpen] = useState(false);
  const [codexGoalBusy, setCodexGoalBusy] = useState(false);
  const codexGoalMutationInFlight = useRef(false);
  const codexGoalThreadStarted = props.selectedThread.session !== null;
  // One path for the banner controls, the editor, and `/goal` commands.
  const runCodexGoalMutation = useCallback(
    async (
      mutation: { kind: "set"; input: CodexGoalSetInput } | { kind: "clear" },
    ): Promise<boolean> => {
      if (codexGoalMutationInFlight.current) return false;
      if (!codexGoalThreadStarted) {
        Alert.alert(
          "Start the Codex thread first",
          "Send a message before managing its native Goal.",
        );
        return false;
      }
      const submittedThreadKey = selectedThreadKey;
      const stillOnSubmittedThread = () => selectedThreadKeyRef.current === submittedThreadKey;
      codexGoalMutationInFlight.current = true;
      setCodexGoalBusy(true);
      try {
        const result =
          mutation.kind === "clear"
            ? await clearCodexGoal({
                environmentId: props.environmentId,
                input: { threadId: props.selectedThread.id },
              })
            : await setCodexGoal({ environmentId: props.environmentId, input: mutation.input });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result) && stillOnSubmittedThread()) {
            Alert.alert(
              "Codex Goal operation failed",
              formatCodexGoalError(squashAtomCommandFailure(result)),
            );
          }
          return false;
        }
        return stillOnSubmittedThread();
      } finally {
        codexGoalMutationInFlight.current = false;
        setCodexGoalBusy(false);
      }
    },
    [
      clearCodexGoal,
      codexGoalThreadStarted,
      props.environmentId,
      props.selectedThread.id,
      selectedThreadKey,
      setCodexGoal,
    ],
  );
  const handleCodexGoalStatusAction = useCallback(
    (action: "pause" | "resume" | "continue") => {
      void runCodexGoalMutation({
        kind: "set",
        input: {
          threadId: props.selectedThread.id,
          status: action === "pause" ? "paused" : "active",
        },
      });
    },
    [props.selectedThread.id, runCodexGoalMutation],
  );
  const handleCodexGoalClear = useCallback(() => {
    const title = "Clear this goal?";
    const message =
      "Codex stops pursuing the objective and forgets its usage. The conversation stays.";
    const onConfirm = () => void runCodexGoalMutation({ kind: "clear" });
    if (Platform.OS === "android") {
      showConfirmDialog({
        title,
        message,
        confirmText: "Clear goal",
        destructive: true,
        onConfirm,
      });
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear goal", style: "destructive", onPress: onConfirm },
    ]);
  }, [runCodexGoalMutation]);
  const handleCodexGoalEditorSubmit = useCallback(
    async (submission: CodexGoalEditorSubmission) => {
      const saved = await runCodexGoalMutation({
        kind: "set",
        input: {
          threadId: props.selectedThread.id,
          objective: submission.objective,
          ...(submission.tokenBudget !== undefined ? { tokenBudget: submission.tokenBudget } : {}),
          // A new objective on a fresh or completed goal starts pursuit;
          // editing a live goal leaves Codex's status alone.
          ...(codexGoal === null || codexGoal.status === "complete"
            ? { status: "active" as const }
            : {}),
        },
      });
      if (saved) setCodexGoalEditorOpen(false);
    },
    [codexGoal, props.selectedThread.id, runCodexGoalMutation],
  );
  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
    setCodexGoalEditorOpen(false);
  }, [selectedThreadKey, showContent]);
  const handleGoalCommand = useCallback(
    (
      draftMessage: string,
      hasAttachments: boolean,
      clearDraft: () => void,
    ): boolean | Promise<boolean> => {
      const draftGoalCommand = !hasAttachments ? parseCodexGoalCommand(draftMessage) : null;
      if (draftGoalCommand !== null && selectedProvider === undefined) {
        Alert.alert("Provider still loading", "Wait for the provider list to finish loading.");
        return true;
      }
      const goalCommand = selectedProvider?.driver === "codex" ? draftGoalCommand : null;
      if (goalCommand !== null) {
        if (goalCommand.action === "invalid") {
          Alert.alert("Invalid Goal command", goalCommand.message);
          return true;
        }
        if (props.selectedThread.session === null) {
          Alert.alert(
            "Start the Codex thread first",
            "Send a message before managing its native Goal.",
          );
          return true;
        }
        const submittedThreadKey = selectedThreadKey;
        const stillOnSubmittedThread = () => selectedThreadKeyRef.current === submittedThreadKey;
        const clearSubmittedGoalCommandDraft = () => {
          if (stillOnSubmittedThread()) clearDraft();
        };
        if (goalCommand.action === "edit") {
          clearSubmittedGoalCommandDraft();
          setCodexGoalEditorOpen(true);
          return true;
        }
        if (goalCommand.action === "status") {
          clearSubmittedGoalCommandDraft();
          Alert.alert(
            codexGoal === null
              ? "No active Codex Goal"
              : `Goal ${formatCodexGoalStatus(codexGoal.status)}`,
            codexGoal === null ? undefined : formatCodexGoalDescription(codexGoal),
          );
          return true;
        }
        return runCodexGoalMutation(
          goalCommand.action === "clear"
            ? { kind: "clear" }
            : { kind: "set", input: toCodexGoalSetInput(props.selectedThread.id, goalCommand) },
        ).then((applied) => {
          if (applied) clearSubmittedGoalCommandDraft();
          return true;
        });
      }
      return false;
    },
    [
      selectedProvider,
      props.selectedThread.session,
      props.selectedThread.id,
      selectedThreadKey,
      codexGoal,
      runCodexGoalMutation,
    ],
  );
  const codexGoalStatusActionValue =
    codexGoal === null ? null : codexGoalStatusAction(codexGoal, codexGoalActivity);
  const handleCodexGoalMenuAction = (event: string) => {
    if (event === "edit") setCodexGoalEditorOpen(true);
    else if (event === "clear") handleCodexGoalClear();
    else if (event === "pause" || event === "resume" || event === "continue") {
      handleCodexGoalStatusAction(event);
    }
  };
  return {
    handleGoalCommand,
    controls: (
      <>
        {codexGoal !== null ? (
          <CodexGoalRow
            goal={codexGoal}
            statusAction={codexGoalStatusActionValue}
            busy={codexGoalBusy}
            onAction={handleCodexGoalMenuAction}
          />
        ) : null}
        <CodexGoalEditorModal
          visible={codexGoalEditorOpen}
          goal={codexGoal}
          saving={codexGoalBusy}
          onClose={() => setCodexGoalEditorOpen(false)}
          onSubmit={handleCodexGoalEditorSubmit}
        />
      </>
    ),
  };
}

type CodexGoalStatusAction = "pause" | "resume" | "continue";

const STATUS_ACTION_MENU: Record<CodexGoalStatusAction, MenuAction> = {
  pause: { id: "pause", title: "Pause", image: "pause" },
  resume: { id: "resume", title: "Resume", image: "play" },
  continue: { id: "continue", title: "Continue", image: "play" },
};
const GOAL_MENU_TAIL: readonly MenuAction[] = [
  { id: "edit", title: "Edit goal", image: "square.and.pencil" },
  { id: "clear", title: "Clear goal", image: "trash", attributes: { destructive: true } },
];
// One stable array per status action, so the native menu's props do not
// change on every feed re-render.
const GOAL_MENU_ACTIONS: Record<CodexGoalStatusAction | "none", MenuAction[]> = {
  pause: [STATUS_ACTION_MENU.pause, ...GOAL_MENU_TAIL],
  resume: [STATUS_ACTION_MENU.resume, ...GOAL_MENU_TAIL],
  continue: [STATUS_ACTION_MENU.continue, ...GOAL_MENU_TAIL],
  none: [...GOAL_MENU_TAIL],
};

function codexGoalStatusClassName(status: OrchestrationThreadGoal["status"]): string {
  switch (status) {
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return "text-adaptive-amber-700-300";
    case "complete":
      return "text-adaptive-emerald-600-400";
    case "paused":
      return "text-foreground-muted";
    case "active":
      return "text-foreground";
  }
}

/**
 * One-line goal row above the composer, in the composer's own pill language:
 * status word, objective, usage. Tapping it opens the native menu with the
 * one status control plus edit and clear, like the desktop banner's menu.
 */
function CodexGoalRow(props: {
  readonly goal: OrchestrationThreadGoal;
  readonly statusAction: CodexGoalStatusAction | null;
  readonly busy: boolean;
  readonly onAction: (event: string) => void;
}) {
  const { goal } = props;
  const actions = GOAL_MENU_ACTIONS[props.statusAction ?? "none"];
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Goal ${formatCodexGoalStatus(goal.status)}: ${goal.objective}`}
      accessibilityHint="Opens goal actions"
      disabled={props.busy}
      className={cn(
        "mx-4 mb-2 min-h-10 flex-row items-center gap-2 rounded-full border-continuous bg-card px-3.5 active:opacity-70",
        props.busy && "opacity-50",
      )}
    >
      <SymbolView
        name="target"
        size={14}
        weight="medium"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <Text className={cn("text-xs font-t3-bold", codexGoalStatusClassName(goal.status))}>
        Goal {formatCodexGoalStatus(goal.status)}
      </Text>
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {goal.objective}
      </Text>
      <Text className="shrink-0 font-mono text-2xs tabular-nums text-foreground-muted">
        {formatCodexGoalUsageCompact(goal)}
      </Text>
      <SymbolView
        name="ellipsis"
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
  if (props.busy) return row;
  return (
    <ControlPillMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      {row}
    </ControlPillMenu>
  );
}
