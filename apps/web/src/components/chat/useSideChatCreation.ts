import { useLayoutEffect, useRef, type RefObject } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { truncate } from "@t3tools/shared/String";
import { useComposerDraftStore } from "../../composerDraftStore";
import { newMessageId, newThreadId } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Thread } from "../../types";
import { toastManager } from "../ui/toast";

export function useSideChatCreation({
  activeThread,
  sideChatAvailable,
  activeEnvironmentUnavailable,
  environmentId,
  routeThreadKey,
  runtimeMode,
  sendInFlightRef,
  setThreadError,
  openSideChatSurface,
}: {
  activeThread: Thread | undefined;
  sideChatAvailable: boolean;
  activeEnvironmentUnavailable: boolean;
  environmentId: EnvironmentId | undefined;
  routeThreadKey: string;
  runtimeMode: RuntimeMode;
  sendInFlightRef: RefObject<boolean>;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  openSideChatSurface: (threadId: string) => void;
}) {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const sideChatRouteRef = useRef<string | null>(routeThreadKey);
  useLayoutEffect(() => {
    sideChatRouteRef.current = routeThreadKey;
    return () => {
      sideChatRouteRef.current = null;
    };
  }, [routeThreadKey]);
  const createSideChat = async (
    prompt: string,
    modelSelection: ModelSelection,
    sideInteractionMode: ProviderInteractionMode,
  ): Promise<boolean> => {
    if (!activeThread || !sideChatAvailable || activeEnvironmentUnavailable || !environmentId)
      return false;
    if (sendInFlightRef.current) return false;
    sendInFlightRef.current = true;
    const sideThreadId = newThreadId();
    const parentRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const panelRevision = useRightPanelStore.getState().getUserActionRevision(parentRef);
    const createdAt = new Date().toISOString();
    try {
      const created = await createThread({
        environmentId,
        input: {
          threadId: sideThreadId,
          projectId: activeThread.projectId,
          title: prompt ? truncate(prompt) : "Side chat",
          modelSelection: modelSelection,
          runtimeMode,
          interactionMode: sideInteractionMode,
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          forkedFromThreadId: activeThread.id,
          createdAt,
        },
      });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created)) {
          const error = squashAtomCommandFailure(created);
          setThreadError(
            activeThread.id,
            error instanceof Error ? error.message : "Could not create side chat.",
          );
        }
        return false;
      }
      const sideRef = scopeThreadRef(activeThread.environmentId, sideThreadId);
      setComposerDraftPrompt(sideRef, prompt);
      if (prompt) {
        const started = await startThreadTurn({
          environmentId,
          input: {
            threadId: sideThreadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: modelSelection,
            runtimeMode,
            interactionMode: sideInteractionMode,
            createdAt,
          },
        });
        if (started._tag !== "Failure") {
          const latestChildDraft = useComposerDraftStore.getState().getComposerDraft(sideRef);
          if (latestChildDraft?.prompt === prompt) setComposerDraftPrompt(sideRef, "");
        } else if (!isAtomCommandInterrupted(started)) {
          const error = squashAtomCommandFailure(started);
          toastManager.add({
            type: "error",
            title: "Side chat message saved as a draft",
            description:
              error instanceof Error ? error.message : "Try sending it again in the side chat.",
          });
          setThreadError(
            sideThreadId,
            error instanceof Error
              ? error.message
              : "Message saved as a draft. Try sending it again.",
          );
        }
      }
      if (
        sideChatRouteRef.current === routeThreadKey &&
        useRightPanelStore.getState().getUserActionRevision(parentRef) === panelRevision
      ) {
        openSideChatSurface(sideThreadId);
      }
      return true;
    } finally {
      sendInFlightRef.current = false;
    }
  };
  const addSideChatSurface = () => {
    if (activeThread)
      void createSideChat("", activeThread.modelSelection, activeThread.interactionMode);
  };

  return { createSideChat, addSideChatSurface, sideChatRouteRef };
}
