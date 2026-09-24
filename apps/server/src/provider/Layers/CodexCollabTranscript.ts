/**
 * Codex child-agent transcripts.
 *
 * The session runtime forwards a collab child's messages and tools as
 * `collabAgent/transcript` notifications on the parent thread, whether or not
 * the child has registered yet: the provider thread id already identifies its
 * owner. The adapter decodes them like ordinary items and tags them with that
 * owner, so they never enter the root transcript.
 */
import type {
  ProviderEvent,
  ProviderItemId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

const CODEX_COLLAB_TRANSCRIPT_METHODS: ReadonlySet<string> = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
]);

/** Child notification methods the runtime forwards as the child's transcript. */
export function isCodexCollabTranscriptMethod(method: string): boolean {
  return CODEX_COLLAB_TRANSCRIPT_METHODS.has(method);
}

/**
 * Wraps a child notification as a transcript event on the parent thread. The
 * runtime emits it under the parent turn that owns the child.
 */
export function codexCollabTranscriptEvent(input: {
  readonly threadId: ThreadId;
  readonly parentTurnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly agentThreadId: string;
  readonly notification: { readonly method: string; readonly params: unknown };
}): Omit<ProviderEvent, "id" | "provider" | "createdAt"> {
  return {
    kind: "notification",
    threadId: input.threadId,
    ...(input.parentTurnId ? { turnId: input.parentTurnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    method: "collabAgent/transcript",
    payload: {
      agentThreadId: input.agentThreadId,
      method: input.notification.method,
      params: input.notification.params,
    },
  };
}

/**
 * Maps a `collabAgent/transcript` event by reusing ordinary item decoding
 * (`mapItemEvents`), then attaches ownership only to transcript events. Child
 * compaction and plans must not change the root turn, and child reasoning
 * stays out as it does in the main transcript.
 */
export function mapCodexCollabTranscript(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  agentThreadId: string,
  mapItemEvents: (
    event: ProviderEvent,
    canonicalThreadId: ThreadId,
  ) => ReadonlyArray<ProviderRuntimeEvent>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = event.payload as { readonly method?: unknown; readonly params?: unknown };
  if (typeof payload.method !== "string" || !isCodexCollabTranscriptMethod(payload.method)) {
    return [];
  }
  return mapItemEvents(
    { ...event, method: payload.method, payload: payload.params },
    canonicalThreadId,
  ).flatMap((entry): ProviderRuntimeEvent[] => {
    if (entry.type === "content.delta") {
      return [{ ...entry, payload: { ...entry.payload, agentId: agentThreadId } }];
    }
    if (
      entry.type === "item.started" ||
      entry.type === "item.updated" ||
      entry.type === "item.completed"
    ) {
      if (entry.payload.itemType === "reasoning") return [];
      return [{ ...entry, payload: { ...entry.payload, agentId: agentThreadId } }];
    }
    return [];
  });
}
