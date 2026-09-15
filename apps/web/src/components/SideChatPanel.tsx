/**
 * A side chat rendered as a right-panel surface beside its parent thread.
 *
 * The side chat is an ordinary server thread whose provider session was forked
 * from the parent (see docs/user/side-chats.md). This panel owns a lean
 * text-only composer and reuses the main chat's timeline rows; anything richer
 * (attachments, mentions, approvals) lives in the full thread view, one click
 * away. Draft text is stored under the side chat's own thread key so it
 * survives tab switches and follows the user into the full view.
 */
import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ServerProviderSkill,
  TimestampFormat,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { truncate } from "@t3tools/shared/String";
import { ArrowUpRight, ChevronDown, Maximize2, MessagesSquare, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";

import { useComposerDraftStore } from "../composerDraftStore";
import { readLocalApi } from "../localApi";
import {
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "../session-logic";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import type { ChatFileAttachment, TurnDiffSummary } from "../types";
import { newMessageId } from "~/lib/utils";
import { buildThreadTurnInterruptInput } from "./ChatView.logic";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { ComposerSurface } from "./chat/ComposerSurface";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const EMPTY_TURN_DIFFS: ReadonlyArray<TurnDiffSummary> = [];
const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);
const NOOP = () => {};

/** The title a fresh side chat is created with; replaced by the first message. */
export const SIDE_CHAT_PLACEHOLDER_TITLE = "Side chat";

export function sideChatTitleFromPrompt(prompt: string): string {
  const seed = assistantCitationsToPlainText(prompt).trim();
  return seed.length > 0 ? truncate(seed) : SIDE_CHAT_PLACEHOLDER_TITLE;
}

function HeaderAction(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function SideChatPanel(props: {
  threadRef: ScopedThreadRef;
  parentTitle: string;
  cwd: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: ((attachment: ChatFileAttachment) => void) | undefined;
  onFileDownload?: ((attachment: ChatFileAttachment) => void) | undefined;
  /** Navigates to the side chat's full thread view. */
  onOpenFullView: () => void;
  /** Removes this tab. The side chat stays attached until deleted or promoted here. */
  onRemoveSurface: () => void;
}) {
  const { threadRef, onOpenFullView, onRemoveSurface } = props;
  const { environmentId, threadId } = threadRef;
  const shell = useThreadShell(threadRef);
  const thread = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const draft = useComposerDraftStore((store) => store.getComposerDraft(threadRef)?.prompt ?? "");
  const requiresProviderSelection = useComposerDraftStore((store) => {
    const provider = store.getComposerDraft(threadRef)?.activeProvider;
    return provider != null && provider !== shell?.modelSelection.instanceId;
  });
  const setDraft = useComposerDraftStore((store) => store.setPrompt);
  const hasRichDraft = useComposerDraftStore((store) => {
    const value = store.getComposerDraft(threadRef);
    return Boolean(
      value &&
      (value.images.length ||
        value.files.length ||
        value.terminalContexts.length ||
        value.previewAnnotations.length ||
        value.reviewComments.length),
    );
  });

  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [action, setAction] = useState<"closing" | "promoting" | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const listRef = useRef<LegendListRef | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendInFlight = useRef(false);

  const messages = thread?.messages ?? EMPTY_MESSAGES;
  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const proposedPlans = thread?.proposedPlans ?? EMPTY_PROPOSED_PLANS;
  const session = thread?.session ?? null;
  const latestTurn = thread?.latestTurn ?? null;
  const phase = derivePhase(session);
  const runningTurnId =
    (session?.status === "running" ? session.activeTurnId : null) ??
    (latestTurn?.state === "running" ? latestTurn.turnId : null);
  // Like the main composer: the send button spins until the server reports
  // the turn, then the stop button takes over.
  const turnRunning = phase === "running" || phase === "connecting";
  const isWorking = turnRunning || sending;
  // The local send anchor only bridges the gap until the server reports the
  // turn; once the session is running, the turn's own start time wins.
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    latestTurn,
    session,
    phase === "running" ? null : sendStartedAt,
  );
  const pendingApprovalCount = useMemo(() => {
    const pending = derivePendingRequests(activities);
    return pending.approvals.length + pending.userInputs.length;
  }, [activities]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(messages, proposedPlans, deriveWorkLogEntries(activities)),
    [activities, messages, proposedPlans],
  );
  const sessionError = session?.lastError ?? null;
  const isGone = status === "deleted";

  // Keyed by thread id upstream, so mount means "this tab just opened": land
  // the cursor here so `/side` + Enter is immediately followed by typing.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (
      text.length === 0 ||
      shell === null ||
      sendInFlight.current ||
      isGone ||
      action !== null ||
      hasRichDraft ||
      requiresProviderSelection ||
      pendingApprovalCount > 0
    )
      return;
    const createdAt = new Date().toISOString();
    const isFirstMessage = messages.length === 0 && latestTurn === null;
    setSending(true);
    sendInFlight.current = true;
    setSendStartedAt(createdAt);
    setLocalError(null);
    setLiveFollowEnabled(true);
    const savedDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection:
          savedDraft?.modelSelectionByProvider[shell.modelSelection.instanceId] ??
          shell.modelSelection,
        titleSeed: sideChatTitleFromPrompt(text),
        runtimeMode: savedDraft?.runtimeMode ?? shell.runtimeMode,
        interactionMode: savedDraft?.interactionMode ?? shell.interactionMode,
        createdAt,
      },
    });
    setSending(false);
    sendInFlight.current = false;
    if (result._tag === "Failure") {
      setSendStartedAt(null);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setLocalError(error instanceof Error ? error.message : "Failed to send message.");
      }
      return;
    }
    if (useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt === draft) {
      setDraft(threadRef, "");
    }
    if (isFirstMessage && shell.title === SIDE_CHAT_PLACEHOLDER_TITLE) {
      void updateMetadata({
        environmentId,
        input: { threadId, title: sideChatTitleFromPrompt(text) },
      });
    }
  }, [
    setDraft,
    draft,
    environmentId,
    isGone,
    latestTurn,
    messages.length,
    action,
    hasRichDraft,
    requiresProviderSelection,
    pendingApprovalCount,
    shell,
    startTurn,
    threadId,
    threadRef,
    updateMetadata,
  ]);

  const stop = useCallback(async () => {
    if (thread === null) return;
    const result = await interruptTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(thread),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setLocalError(error instanceof Error ? error.message : "Failed to stop the side chat.");
    }
  }, [environmentId, interruptTurn, thread]);

  const close = useCallback(async () => {
    if (action !== null) return;
    const message = "Delete this side chat? Its messages will be permanently deleted.";
    const localApi = readLocalApi();
    const confirmed = localApi
      ? await localApi.dialogs.confirm(message, { variant: "destructive" })
      : window.confirm(message);
    if (!confirmed) return;
    setAction("closing");
    const result = await deleteThread({ environmentId, input: { threadId } });
    setAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setLocalError(error instanceof Error ? error.message : "Failed to close side chat.");
      }
      return;
    }
    onRemoveSurface();
  }, [action, deleteThread, environmentId, onRemoveSurface, threadId]);

  // Promotion detaches the side chat: it leaves this panel, joins the thread
  // list, and opens as an ordinary thread.
  const promote = useCallback(async () => {
    if (action !== null) return;
    setAction("promoting");
    const result = await updateMetadata({
      environmentId,
      input: { threadId, sideChatPromotedAt: new Date().toISOString() },
    });
    setAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setLocalError(error instanceof Error ? error.message : "Failed to promote side chat.");
      }
      return;
    }
    onRemoveSurface();
    onOpenFullView();
  }, [action, environmentId, onOpenFullView, onRemoveSurface, threadId, updateMetadata]);

  const title = shell?.title ?? SIDE_CHAT_PLACEHOLDER_TITLE;
  const statusLabel = isGone
    ? "Closed"
    : pendingApprovalCount > 0
      ? "Waiting for you"
      : isWorking
        ? "Working"
        : sessionError
          ? "Error"
          : null;
  const composerDisabled =
    shell === null ||
    isGone ||
    action !== null ||
    hasRichDraft ||
    requiresProviderSelection ||
    pendingApprovalCount > 0;
  const errorText = localError ?? sessionError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <MessagesSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {statusLabel ? (
          <span className="shrink-0 text-[.65rem] text-muted-foreground">{statusLabel}</span>
        ) : null}
        <HeaderAction label="Open full view" onClick={onOpenFullView}>
          <Maximize2 className="size-3.5" />
        </HeaderAction>
        <HeaderAction
          label={action === "promoting" ? "Promoting…" : "Promote to thread"}
          disabled={action !== null || isGone}
          onClick={() => void promote()}
        >
          <ArrowUpRight className="size-3.5" />
        </HeaderAction>
        <HeaderAction
          label={action === "closing" ? "Deleting…" : "Delete side chat"}
          disabled={action !== null || isGone}
          onClick={() => void close()}
        >
          <Trash2 className="size-3.5" />
        </HeaderAction>
      </header>

      {pendingApprovalCount > 0 || hasRichDraft || requiresProviderSelection ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/35 px-3 py-1.5 text-xs">
          <span>
            {hasRichDraft || requiresProviderSelection
              ? "Continue this draft in full view."
              : "The agent is waiting for your answer."}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={onOpenFullView}>
            Respond in full view
          </Button>
        </div>
      ) : null}

      {errorText ? (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          {errorText}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {isGone ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <span>This side chat was closed.</span>
            <Button type="button" size="xs" variant="outline" onClick={onRemoveSurface}>
              Remove tab
            </Button>
          </div>
        ) : thread === null || timelineEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-muted-foreground">
            {thread === null ? (
              <span>Opening side chat…</span>
            ) : (
              <>
                <span className="text-foreground">Forked from “{props.parentTitle}”</span>
                <span>It already knows everything in that thread. Ask away.</span>
              </>
            )}
          </div>
        ) : (
          <>
            <MessagesTimeline
              loadEarlier={null}
              isWorking={isWorking}
              activeTurnStartedAt={isWorking ? activeWorkStartedAt : null}
              listRef={listRef}
              timelineEntries={timelineEntries}
              latestTurn={latestTurn}
              runningTurnId={isWorking ? runningTurnId : null}
              turnDiffSummaries={EMPTY_TURN_DIFFS}
              routeThreadKey={scopedThreadKey(threadRef)}
              onOpenTurnDiff={NOOP}
              supportsConversationRollback={false}
              onRevertToTurnCount={NOOP}
              isRevertingCheckpoint={false}
              onImageExpand={props.onImageExpand}
              {...(props.onFileOpen ? { onFileOpen: props.onFileOpen } : {})}
              {...(props.onFileDownload ? { onFileDownload: props.onFileDownload } : {})}
              activeThreadEnvironmentId={environmentId}
              markdownCwd={props.cwd}
              resolvedTheme={props.resolvedTheme}
              timestampFormat={props.timestampFormat}
              workspaceRoot={props.cwd}
              skills={props.skills}
              anchorMessageId={null}
              onAnchorReady={NOOP}
              contentInsetEndAdjustment={0}
              liveFollowEnabled={liveFollowEnabled}
              onIsAtEndChange={(atEnd) => {
                if (atEnd) setLiveFollowEnabled(true);
              }}
              onManualNavigation={() => setLiveFollowEnabled(false)}
            />
            {!liveFollowEnabled ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
                <button
                  type="button"
                  aria-label="Scroll to end"
                  onClick={() => {
                    setLiveFollowEnabled(true);
                    void listRef.current?.scrollToEnd?.({ animated: true });
                  }}
                  className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground"
                >
                  <ChevronDown className="size-3.5" />
                  Scroll to end
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {!isGone ? (
        <form
          className="p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {/* Same glass surface, placeholder and buttons as the main composer;
              only the text field, since anything richer lives in the full view. */}
          <ComposerSurface.Shell>
            <ComposerSurface.Host>
              {/* The main composer's resting row: field and send button side by
                  side, growing with the draft. */}
              <div className="relative z-10 flex items-end gap-2 py-2 ps-3 pe-2 sm:ps-4">
                <textarea
                  ref={textareaRef}
                  aria-label="Side chat message"
                  placeholder={shell === null ? "Opening side chat…" : "Ask side chat"}
                  rows={1}
                  disabled={composerDisabled}
                  className="field-sizing-content block max-h-[min(20rem,40dvh)] min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 leading-relaxed text-foreground outline-none [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] placeholder:text-placeholder/75 disabled:opacity-60"
                  value={draft}
                  onChange={(event) => setDraft(threadRef, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="flex h-8 shrink-0 items-center">
                  <ComposerPrimaryActions
                    compact
                    pendingAction={null}
                    isRunning={turnRunning}
                    showPlanFollowUpPrompt={false}
                    promptHasText={draft.trim().length > 0}
                    isSendBusy={sending}
                    sendDisabledReason={composerDisabled ? "Open full view to continue." : null}
                    isConnecting={phase === "connecting"}
                    isEnvironmentUnavailable={false}
                    isPreparingWorktree={false}
                    hasSendableContent={draft.trim().length > 0}
                    onPreviousPendingQuestion={NOOP}
                    onInterrupt={() => void stop()}
                    onImplementPlanInNewThread={NOOP}
                  />
                </div>
              </div>
            </ComposerSurface.Host>
          </ComposerSurface.Shell>
        </form>
      ) : null}
    </div>
  );
}
