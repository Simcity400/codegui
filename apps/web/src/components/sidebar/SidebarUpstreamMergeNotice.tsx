import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { BotIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { buildUpstreamMergePrompt, describeUpstreamMerge } from "./upstreamMerge.logic";

// Personal fork: Fork Sync could not merge an official nightly on its own.
// The desktop updater reads the marker it left; this notice turns that into
// one action: a new thread whose prompt asks an agent to finish the merge.
export function SidebarUpstreamMergeNotice() {
  return isElectron ? <SidebarUpstreamMergeNoticeContent /> : null;
}

function SidebarUpstreamMergeNoticeContent() {
  const state = useDesktopUpdateState();
  const status = state?.upstreamMerge ?? null;
  const { activeThread, activeDraftThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const [dismissedTag, setDismissedTag] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const openMergeThread = async () => {
    if (!status || isOpening) return;
    // The thread starts in the project the user is looking at, else the first
    // in their order; the draft's project picker is one click away when the
    // fork lives elsewhere, and the prompt names the repository.
    const current = activeThread ?? activeDraftThread;
    const projectRef = current
      ? scopeProjectRef(current.environmentId, current.projectId)
      : defaultProjectRef;
    if (!projectRef) return;
    setIsOpening(true);
    try {
      const opened = await handleNewThread(projectRef);
      if (opened) {
        useComposerDraftStore
          .getState()
          .setPrompt(opened.draftId, buildUpstreamMergePrompt(status));
      }
    } finally {
      setIsOpening(false);
    }
  };

  if (!status || dismissedTag === status.tag) return null;

  return (
    <Alert
      variant="warning"
      className="relative rounded-2xl border-warning/40 bg-warning/8 text-xs"
    >
      <TriangleAlertIcon />
      <AlertTitle>Official update needs a merge</AlertTitle>
      <AlertDescription>
        <p>{describeUpstreamMerge(status)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" onClick={() => void openMergeThread()} disabled={isOpening}>
            <BotIcon />
            Finish with an agent
          </Button>
        </div>
      </AlertDescription>
      <button
        type="button"
        aria-label="Dismiss merge notice"
        className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-md text-warning/70 transition-colors hover:text-warning"
        onClick={() => setDismissedTag(status.tag)}
      >
        <XIcon className="size-3.5" />
      </button>
    </Alert>
  );
}
