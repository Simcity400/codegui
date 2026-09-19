import { isAttachedSideChat } from "@t3tools/client-runtime/state/sideChat";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, CornerUpLeft, MessagesSquare, Trash2 } from "lucide-react";
import { memo, useState } from "react";

import { readLocalApi } from "../../localApi";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Shown above the transcript when an attached side chat is opened as a full
 * thread (narrow layouts, or "Open full view"). It is the only place such a
 * thread exposes its lineage, since it never appears in thread lists.
 */
export const SideChatBar = memo(function SideChatBar({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell({ environmentId, threadId });
  const parentId = thread?.forkedFromThreadId ?? null;
  const parent = useThreadShell(parentId ? { environmentId, threadId: parentId } : null);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const [busy, setBusy] = useState<"promote" | "delete" | null>(null);

  if (!thread || !isAttachedSideChat(thread)) return null;

  const openParent = () => {
    if (!parentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: parentId }),
    });
  };
  const promote = async () => {
    if (busy) return;
    setBusy("promote");
    const result = await updateMetadata({
      environmentId,
      input: { threadId, sideChatPromotedAt: new Date().toISOString() },
    });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not promote side chat", squashAtomCommandFailure(result));
    }
  };
  const remove = async () => {
    if (busy) return;
    const message = "Delete this side chat? Its messages will be permanently deleted.";
    const localApi = readLocalApi();
    const confirmed = localApi
      ? await localApi.dialogs.confirm(message, { variant: "destructive" })
      : window.confirm(message);
    if (!confirmed) return;
    setBusy("delete");
    const result = await deleteThread({ environmentId, input: { threadId } });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete side chat", squashAtomCommandFailure(result));
      }
      return;
    }
    if (parent) openParent();
    else void navigate({ to: "/" });
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1 text-xs">
      <MessagesSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Side chat of <span className="text-foreground">{parent?.title ?? "a deleted thread"}</span>
      </span>
      {parent ? (
        <Button type="button" variant="ghost" size="compact" onClick={openParent}>
          <CornerUpLeft /> Open original
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="compact"
        disabled={busy !== null}
        onClick={() => void promote()}
      >
        <ArrowUpRight /> {busy === "promote" ? "Promoting…" : "Promote to thread"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        className="text-destructive hover:text-destructive"
        disabled={busy !== null}
        onClick={() => void remove()}
      >
        <Trash2 /> {busy === "delete" ? "Deleting…" : "Delete"}
      </Button>
    </div>
  );
});
