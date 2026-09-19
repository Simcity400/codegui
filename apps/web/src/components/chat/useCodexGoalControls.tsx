import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CodexGoalSetInput,
  EnvironmentId,
  OrchestrationSession,
  OrchestrationThreadGoal,
  ThreadId,
} from "@t3tools/contracts";
import {
  codexGoalSessionActivity,
  formatCodexGoalDescription,
  formatCodexGoalError,
  formatCodexGoalStatus,
  parseCodexGoalCommand,
  toCodexGoalSetInput,
} from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildCodexGoalBannerItem,
  CodexGoalClearDialog,
  CodexGoalEditorDialog,
  type CodexGoalEditorSubmission,
  type CodexGoalStatusAction,
} from "./CodexGoalBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function useCodexGoalControls({
  environmentId,
  routeThreadKey,
  activeThreadKey,
  activeThreadId,
  isServerThread,
  session,
  codexGoal,
}: {
  environmentId: EnvironmentId;
  routeThreadKey: string;
  activeThreadKey: string | null;
  activeThreadId: ThreadId | null;
  isServerThread: boolean;
  session: OrchestrationSession | null | undefined;
  codexGoal: OrchestrationThreadGoal | null;
}) {
  const setCodexGoal = useAtomCommand(threadEnvironment.setCodexGoal, { reportFailure: false });
  const clearCodexGoal = useAtomCommand(threadEnvironment.clearCodexGoal, { reportFailure: false });
  const [goalCommandThreadKeysInFlight, setGoalCommandThreadKeysInFlight] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const goalCommandRunning = goalCommandThreadKeysInFlight.has(routeThreadKey);
  const goalCommandsInFlightRef = useRef(new Set<string>());
  const activeThreadKeyRef = useRef(activeThreadKey);
  useLayoutEffect(() => {
    activeThreadKeyRef.current = activeThreadKey;
  }, [activeThreadKey]);
  const [codexGoalDialog, setCodexGoalDialog] = useState<{
    threadKey: string;
    kind: "edit" | "clear";
  } | null>(null);
  const codexGoalEditorOpen =
    codexGoalDialog?.threadKey === routeThreadKey && codexGoalDialog.kind === "edit";
  const codexGoalClearOpen =
    codexGoalDialog?.threadKey === routeThreadKey && codexGoalDialog.kind === "clear";
  const setCodexGoalEditorOpen = useCallback(
    (open: boolean) => {
      setCodexGoalDialog(open ? { threadKey: routeThreadKey, kind: "edit" } : null);
    },
    [routeThreadKey],
  );
  const setCodexGoalClearOpen = useCallback(
    (open: boolean) => {
      setCodexGoalDialog(open ? { threadKey: routeThreadKey, kind: "clear" } : null);
    },
    [routeThreadKey],
  );
  // One path for the banner controls, the editor, and `/goal` commands: the
  // in-flight marker blocks sends on this thread until Codex has answered.
  const runCodexGoalMutation = useCallback(
    async (
      mutation:
        | { readonly kind: "set"; readonly input: CodexGoalSetInput }
        | { readonly kind: "clear"; readonly threadId: ThreadId },
    ): Promise<boolean> => {
      if (!isServerThread || session == null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start the Codex thread first",
            description: "Send a message before managing its native Goal.",
          }),
        );
        return false;
      }
      if (goalCommandsInFlightRef.current.has(routeThreadKey)) return false;
      const submittedThreadKey = activeThreadKey;
      const submittedGoalCommandThreadKey = routeThreadKey;
      const stillOnSubmittedThread = () => activeThreadKeyRef.current === submittedThreadKey;
      goalCommandsInFlightRef.current.add(submittedGoalCommandThreadKey);
      setGoalCommandThreadKeysInFlight((current) => {
        const next = new Set(current);
        next.add(submittedGoalCommandThreadKey);
        return next;
      });
      try {
        const result =
          mutation.kind === "clear"
            ? await clearCodexGoal({ environmentId, input: { threadId: mutation.threadId } })
            : await setCodexGoal({ environmentId, input: mutation.input });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result) && stillOnSubmittedThread()) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Codex Goal operation failed",
                description: formatCodexGoalError(squashAtomCommandFailure(result)),
              }),
            );
          }
          return false;
        }
        return true;
      } finally {
        goalCommandsInFlightRef.current.delete(submittedGoalCommandThreadKey);
        setGoalCommandThreadKeysInFlight((current) => {
          const next = new Set(current);
          next.delete(submittedGoalCommandThreadKey);
          return next;
        });
      }
    },
    [
      session,
      activeThreadKey,
      clearCodexGoal,
      environmentId,
      isServerThread,
      routeThreadKey,
      setCodexGoal,
    ],
  );
  const handleCodexGoalStatusAction = useCallback(
    (action: CodexGoalStatusAction) => {
      if (activeThreadId === null) return;
      void runCodexGoalMutation({
        kind: "set",
        input: { threadId: activeThreadId, status: action === "pause" ? "paused" : "active" },
      });
    },
    [activeThreadId, runCodexGoalMutation],
  );
  const handleCodexGoalEditorSubmit = useCallback(
    async (submission: CodexGoalEditorSubmission) => {
      if (activeThreadId === null) return;
      const submittedThreadKey = activeThreadKey;
      const saved = await runCodexGoalMutation({
        kind: "set",
        input: {
          threadId: activeThreadId,
          objective: submission.objective,
          ...(submission.tokenBudget !== undefined ? { tokenBudget: submission.tokenBudget } : {}),
          // A new objective on a fresh or completed goal starts pursuit;
          // editing a live goal leaves Codex's status alone.
          ...(codexGoal === null || codexGoal.status === "complete"
            ? { status: "active" as const }
            : {}),
        },
      });
      if (saved && activeThreadKeyRef.current === submittedThreadKey) setCodexGoalEditorOpen(false);
    },
    [activeThreadId, activeThreadKey, codexGoal, runCodexGoalMutation, setCodexGoalEditorOpen],
  );
  const codexGoalActivity = codexGoalSessionActivity(session ?? null);
  const codexGoalBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (codexGoal === null || activeThreadId === null) return null;
    return buildCodexGoalBannerItem({
      id: `codex-goal:${activeThreadId}`,
      goal: codexGoal,
      activity: codexGoalActivity,
      busy: goalCommandRunning,
      onStatusAction: handleCodexGoalStatusAction,
      onEdit: () => setCodexGoalEditorOpen(true),
      onClear: () => setCodexGoalClearOpen(true),
    });
  }, [
    activeThreadId,
    codexGoal,
    codexGoalActivity,
    goalCommandRunning,
    handleCodexGoalStatusAction,
    setCodexGoalEditorOpen,
    setCodexGoalClearOpen,
  ]);
  const handleGoalCommand = (
    trimmed: string,
    clearDraft: () => void,
  ): boolean | Promise<boolean> => {
    const codexGoalCommand = parseCodexGoalCommand(trimmed);
    if (codexGoalCommand !== null) {
      if (codexGoalCommand.action === "invalid") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Invalid Goal command",
            description: codexGoalCommand.message,
          }),
        );
        return true;
      }
      if (!isServerThread || activeThreadId === null || session === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start the Codex thread first",
            description: "Send a message before managing its native Goal.",
          }),
        );
        return true;
      }

      const submittedThreadKey = activeThreadKey;
      const stillOnSubmittedThread = () => activeThreadKeyRef.current === submittedThreadKey;
      const clearSubmittedGoalCommandDraft = () => {
        if (stillOnSubmittedThread()) clearDraft();
      };
      if (codexGoalCommand.action === "edit") {
        clearSubmittedGoalCommandDraft();
        setCodexGoalEditorOpen(true);
        return true;
      }
      if (codexGoalCommand.action === "status") {
        clearSubmittedGoalCommandDraft();
        toastManager.add(
          stackedThreadToast(
            codexGoal === null
              ? { type: "info", title: "No active Codex Goal" }
              : {
                  type: "info",
                  title: `Goal ${formatCodexGoalStatus(codexGoal.status)}`,
                  description: formatCodexGoalDescription(codexGoal),
                },
          ),
        );
        return true;
      }
      return runCodexGoalMutation(
        codexGoalCommand.action === "clear"
          ? { kind: "clear", threadId: activeThreadId }
          : { kind: "set", input: toCodexGoalSetInput(activeThreadId, codexGoalCommand) },
      ).then((applied) => {
        if (applied) clearSubmittedGoalCommandDraft();
        return true;
      });
    }
    return false;
  };
  return {
    goalCommandRunning,
    goalCommandsInFlightRef,
    codexGoalBannerItem,
    handleGoalCommand,
    dialogs: (
      <>
        <CodexGoalEditorDialog
          open={codexGoalEditorOpen}
          goal={codexGoal}
          saving={goalCommandRunning}
          onClose={() => setCodexGoalEditorOpen(false)}
          onSubmit={handleCodexGoalEditorSubmit}
        />
        <CodexGoalClearDialog
          open={codexGoalClearOpen}
          onOpenChange={setCodexGoalClearOpen}
          onConfirm={() => {
            if (activeThreadId !== null)
              void runCodexGoalMutation({ kind: "clear", threadId: activeThreadId });
          }}
        />
      </>
    ),
  };
}
