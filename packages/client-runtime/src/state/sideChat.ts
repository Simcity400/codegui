import type { EnvironmentThreadShell } from "./shell.ts";

type SideChatLineage = Pick<EnvironmentThreadShell, "forkedFromThreadId" | "sideChatPromotedAt">;
type SideChatIdentity = Pick<EnvironmentThreadShell, "id" | "environmentId">;

/**
 * A side chat stays attached to its parent until it is promoted or deleted.
 * Attached side chats live only in the parent's side panel (web) or side
 * chats screen (mobile); they never appear in thread lists.
 */
export function isAttachedSideChat(thread: SideChatLineage): boolean {
  return thread.forkedFromThreadId != null && thread.sideChatPromotedAt == null;
}

/** Thread lists show everything except attached side chats. */
export function visibleThreadShells<T extends SideChatLineage>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.some(isAttachedSideChat) ? threads.filter((t) => !isAttachedSideChat(t)) : threads;
}

/** The attached side chats of one parent, oldest first. */
export function attachedSideChatsOf<
  T extends SideChatLineage & SideChatIdentity & { createdAt: string },
>(parent: SideChatIdentity, threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === parent.environmentId &&
        thread.forkedFromThreadId === parent.id &&
        thread.sideChatPromotedAt == null,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
