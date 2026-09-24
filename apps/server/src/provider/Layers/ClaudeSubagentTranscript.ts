/**
 * Subagent transcripts for the Claude adapter.
 *
 * The CLI forwards subagent work only as assistant/user snapshots tagged with
 * parent_tool_use_id, never as stream events. This module records those
 * snapshots as the owning agent's transcript and closes the tools an agent
 * leaves open. The adapter wires it once with its event plumbing and calls it
 * from its snapshot, task, and turn-result handlers.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type CanonicalItemType,
  type EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

/** The adapter's in-flight tool record, as far as transcripts read and write it. */
export interface ClaudeSubagentTool {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly agentId?: string;
  readonly parentToolUseId?: string;
}

/** The adapter session state transcripts read and write. */
export interface ClaudeSubagentTranscriptContext {
  readonly session: { readonly threadId: ThreadId };
  readonly turnState: { readonly turnId: TurnId } | undefined;
  /** Stream content blocks own the non-negative indexes; snapshot tools take negative ones. */
  readonly inFlightTools: Map<number, ClaudeSubagentTool>;
  /** Task ids that have started and not yet reached a terminal state. */
  readonly liveTaskIds: ReadonlySet<string>;
}

export interface ClaudeSubagentTranscriptDeps<E> {
  readonly makeEventStamp: () => Effect.Effect<
    { readonly eventId: EventId; readonly createdAt: string },
    E
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly classifyToolItemType: (
    toolName: string,
    input: Record<string, unknown>,
  ) => CanonicalItemType;
  readonly titleForTool: (itemType: CanonicalItemType) => string;
  readonly summarizeToolRequest: (toolName: string, input: Record<string, unknown>) => string;
}

export function makeClaudeSubagentTranscript<E>(deps: ClaudeSubagentTranscriptDeps<E>) {
  const { makeEventStamp, offerRuntimeEvent } = deps;

  const toolItemFields = (
    context: ClaudeSubagentTranscriptContext,
    tool: ClaudeSubagentTool,
    rawMethod: string,
    rawPayload: unknown,
  ) => ({
    provider: PROVIDER,
    threadId: context.session.threadId,
    ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
    itemId: RuntimeItemId.make(tool.itemId),
    providerRefs: { providerItemId: ProviderItemId.make(tool.itemId) },
    raw: {
      source: "claude.sdk.message" as const,
      method: rawMethod,
      payload: rawPayload,
    },
  });

  const toolItemPayload = (tool: ClaudeSubagentTool) => ({
    itemType: tool.itemType,
    title: tool.title,
    ...(tool.detail ? { detail: tool.detail } : {}),
    ...(tool.agentId ? { agentId: tool.agentId } : {}),
    ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
    data: {
      toolName: tool.toolName,
      input: tool.input,
    },
  });

  const completeTools = Effect.fn("completeTools")(function* (
    context: ClaudeSubagentTranscriptContext,
    shouldComplete: (tool: ClaudeSubagentTool) => boolean,
    status: "completed" | "failed",
    rawMethod: string,
    rawPayload: unknown,
  ) {
    for (const [index, tool] of Array.from(context.inFlightTools.entries())) {
      if (!shouldComplete(tool)) continue;
      context.inFlightTools.delete(index);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        createdAt: stamp.createdAt,
        ...toolItemFields(context, tool, rawMethod, rawPayload),
        payload: { ...toolItemPayload(tool), status },
      });
    }
  });

  /**
   * Records a subagent snapshot's tools and text as the owning agent's
   * transcript; tool results then match through `inFlightTools` like the
   * parent's. Thinking stays out, as it does in the main transcript.
   * Snapshots whose agent is unknown are held back as unowned child traffic.
   */
  const recordSnapshot = Effect.fn("recordSnapshot")(function* (
    context: ClaudeSubagentTranscriptContext,
    message: SDKMessage & { readonly type: "assistant" },
    agentId: string | undefined,
  ) {
    const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (!agentId || !parentToolUseId) return;
    const content = (message.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const [blockIndex, entry] of content.entries()) {
      if (!entry || typeof entry !== "object") continue;
      const block = entry as Record<string, unknown>;
      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (text.length === 0) continue;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          itemId: RuntimeItemId.make(`${message.uuid}:${blockIndex}`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            detail: text,
            agentId,
            parentToolUseId,
          },
          providerRefs: {},
          raw: { source: "claude.sdk.message", method: "claude/assistant", payload: message },
        });
        continue;
      }
      if (
        (block.type !== "tool_use" &&
          block.type !== "server_tool_use" &&
          block.type !== "mcp_tool_use") ||
        typeof block.id !== "string" ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const itemId = block.id;
      if (Array.from(context.inFlightTools.values()).some((tool) => tool.itemId === itemId)) {
        continue;
      }
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemType = deps.classifyToolItemType(block.name, input);
      const tool: ClaudeSubagentTool = {
        itemId,
        itemType,
        toolName: block.name,
        title: deps.titleForTool(itemType),
        detail: deps.summarizeToolRequest(block.name, input),
        input,
        partialInputJson: "",
        agentId,
        parentToolUseId,
      };
      context.inFlightTools.set(Math.min(0, ...context.inFlightTools.keys()) - 1, tool);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        createdAt: stamp.createdAt,
        ...toolItemFields(context, tool, "claude/assistant", message),
        payload: { ...toolItemPayload(tool), status: "inProgress" },
      });
    }
  });

  return {
    recordSnapshot,
    /** Closes the tools a task left open when it ends (task_updated or task_notification). */
    closeTaskTools: (
      context: ClaudeSubagentTranscriptContext,
      message: { readonly subtype: string; readonly task_id: string },
      status: string,
    ) =>
      completeTools(
        context,
        (tool) => tool.agentId === message.task_id,
        status === "completed" ? "completed" : "failed",
        `claude/system/${message.subtype}`,
        message,
      ),
    /**
     * Closes the turn's tools on its result. Background subagents outlive the
     * parent turn; their tools stay open until their own results or their
     * task's end arrive.
     */
    closeTurnTools: (
      context: ClaudeSubagentTranscriptContext,
      status: string,
      rawPayload: unknown,
    ) =>
      completeTools(
        context,
        (tool) => tool.agentId === undefined || !context.liveTaskIds.has(tool.agentId),
        status === "completed" ? "completed" : "failed",
        "claude/result",
        rawPayload,
      ),
  };
}
