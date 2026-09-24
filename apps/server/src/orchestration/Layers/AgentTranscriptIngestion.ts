import {
  type CommandId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ProviderRuntimeEvent,
  type ResponseStreamingMode,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const PENDING_AGENT_MESSAGES_CACHE_CAPACITY = 10_000;
const PENDING_AGENT_MESSAGES_TTL = Duration.minutes(120);

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

/**
 * Persists provider session boundaries so clients and the live-task pin query
 * can tell the previous session's orphaned tasks from current ones. Called
 * first by `runtimeEventToActivities`; undefined leaves the event to it.
 */
export function sessionResetActivity(
  event: ProviderRuntimeEvent,
  maybeSequence: { sequence?: number },
): OrchestrationThreadActivity | undefined {
  if (
    event.type !== "session.exited" &&
    (event.type !== "session.state.changed" ||
      (event.payload.state !== "starting" &&
        event.payload.state !== "error" &&
        event.payload.state !== "stopped"))
  ) {
    return undefined;
  }
  return {
    id: event.eventId,
    createdAt: event.createdAt,
    tone: "info",
    kind: "session.reset",
    summary: "Provider session changed",
    payload: { timelineBypass: true },
    turnId: null,
    ...maybeSequence,
  };
}

/**
 * Closure helpers from ProviderRuntimeIngestion that child transcripts reuse,
 * so buffering and completion stay identical to root assistant messages.
 */
export interface AgentTranscriptIngestionDeps {
  readonly providerCommandId: (
    event: ProviderRuntimeEvent,
    tag: string,
  ) => Effect.Effect<CommandId, PlatformError.PlatformError>;
  readonly getThreadMessageById: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<ProjectionThreadMessage | undefined, ProjectionRepositoryError>;
  readonly resolveResponseStreamingMode: (
    projectId: ProjectId,
  ) => Effect.Effect<ResponseStreamingMode, ServerSettingsError>;
  readonly appendBufferedAssistantText: (
    messageId: MessageId,
    delta: string,
    mode: Exclude<ResponseStreamingMode, "token">,
    atMillis: number,
  ) => Effect.Effect<string>;
  readonly finalizeAssistantMessage: (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
    agentId?: string;
  }) => Effect.Effect<void, OrchestrationDispatchError | PlatformError.PlatformError>;
  readonly runtimeEventToActivities: (
    event: ProviderRuntimeEvent,
  ) => ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Routes subagent (child) transcript items into their own messages. Built once
 * inside ProviderRuntimeIngestion's `make`; `ingest` runs for every runtime
 * event after the thread resolves and returns true when the event was a child
 * item that needs no root-thread processing.
 */
export const makeAgentTranscriptIngestion = Effect.fnUntraced(function* (
  deps: AgentTranscriptIngestionDeps,
) {
  const orchestrationEngine = yield* OrchestrationEngineService;

  // Children can outlive the parent turn and may stop without item/completed.
  const pendingAgentMessages = yield* Cache.make<
    ThreadId,
    ReadonlyMap<MessageId, { agentId: string; turnId: TurnId | undefined }>
  >({
    capacity: PENDING_AGENT_MESSAGES_CACHE_CAPACITY,
    timeToLive: PENDING_AGENT_MESSAGES_TTL,
    lookup: () => Effect.succeed(new Map()),
  });

  const forgetAgentMessage = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const pending = new Map(yield* Cache.get(pendingAgentMessages, threadId));
    pending.delete(messageId);
    if (pending.size === 0) {
      yield* Cache.invalidate(pendingAgentMessages, threadId);
    } else {
      yield* Cache.set(pendingAgentMessages, threadId, pending);
    }
  });

  const finalizeAgentMessages = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    agentId?: string,
  ) {
    const pending = yield* Cache.getOption(pendingAgentMessages, event.threadId);
    if (Option.isNone(pending)) return;
    for (const [messageId, owner] of pending.value) {
      if (agentId !== undefined && owner.agentId !== agentId) continue;
      const existing = yield* deps.getThreadMessageById(event.threadId, messageId);
      yield* deps.finalizeAssistantMessage({
        event,
        threadId: event.threadId,
        messageId,
        agentId: owner.agentId,
        ...(owner.turnId ? { turnId: owner.turnId } : {}),
        createdAt: event.createdAt,
        commandTag: "agent-stopped-complete",
        finalDeltaCommandTag: "agent-stopped-final-delta",
        hasProjectedMessage: existing !== undefined,
      });
      yield* forgetAgentMessage(event.threadId, messageId);
    }
  });

  const ingest = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    thread: { readonly id: ThreadId; readonly projectId: ProjectId },
  ) {
    if (
      (event.type === "content.delta" ||
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      event.payload.agentId
    ) {
      // Child messages use their own item identity and never touch the root's
      // active text/reasoning segment, turn state, or completion bookkeeping.
      const agentId = event.payload.agentId;
      const messageId = MessageId.make(
        `agent:${agentId}:assistant:${event.itemId ?? event.eventId}`,
      );
      const turnId = toTurnId(event.turnId);
      if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        const pending = new Map(yield* Cache.get(pendingAgentMessages, thread.id));
        if (!pending.has(messageId)) {
          pending.set(messageId, { agentId, turnId });
          yield* Cache.set(pendingAgentMessages, thread.id, pending);
        }
        const mode = yield* deps.resolveResponseStreamingMode(thread.projectId);
        const delta =
          mode === "token"
            ? event.payload.delta
            : yield* deps.appendBufferedAssistantText(
                messageId,
                event.payload.delta,
                mode,
                yield* Clock.currentTimeMillis,
              );
        if (delta.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* deps.providerCommandId(event, "agent-assistant-delta"),
            threadId: thread.id,
            messageId,
            agentId,
            delta,
            ...(turnId ? { turnId } : {}),
            createdAt: event.createdAt,
          });
        }
      } else if (
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message"
      ) {
        const existing = yield* deps.getThreadMessageById(thread.id, messageId);
        // A repeated completion must not append the snapshot twice.
        if (existing?.isStreaming !== false) {
          yield* deps.finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId,
            agentId,
            ...(turnId ? { turnId } : {}),
            createdAt: event.createdAt,
            commandTag: "agent-assistant-complete",
            finalDeltaCommandTag: "agent-assistant-final-delta",
            hasProjectedMessage: existing !== undefined,
            ...((existing === undefined || existing.text.length === 0) &&
            event.payload.detail !== undefined
              ? { fallbackText: event.payload.detail }
              : {}),
          });
        }
        yield* forgetAgentMessage(thread.id, messageId);
      }
      yield* Effect.forEach(deps.runtimeEventToActivities(event), (activity) =>
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* deps.providerCommandId(event, "agent-activity-append"),
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          });
        }),
      );
      return true;
    }

    if (event.type === "session.exited") {
      yield* finalizeAgentMessages(event);
    } else if (
      event.provider === "codex" &&
      (event.type === "task.completed" ||
        ((event.type === "task.updated" || event.type === "task.progress") &&
          (event.payload.status === "idle" ||
            event.payload.status === "completed" ||
            event.payload.status === "interrupted" ||
            event.payload.status === "cancelled" ||
            event.payload.status === "failed")))
    ) {
      // Codex's task represents the child itself. Task linkage's agentId
      // instead describes the agent owning a task for other providers.
      yield* finalizeAgentMessages(event, event.payload.taskId);
    }
    return false;
  });

  return { ingest };
});
