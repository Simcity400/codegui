import { selectAgentTranscript } from "@t3tools/client-runtime/state/agent-transcripts";
import { EventId, MessageId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";

it("renders attributed stored text and tool output through the main transcript projection", () => {
  const at = "2026-09-08T00:00:00.000Z";
  const activities: OrchestrationThreadActivity[] = [
    {
      // Persisted by older servers; the main transcript never shows reasoning,
      // so agent transcripts hide it as well.
      id: EventId.make("reasoning"),
      kind: "content.completed",
      summary: "Thinking",
      tone: "info",
      turnId: null,
      createdAt: at,
      payload: {
        agentId: "agent-a",
        timelineBypass: true,
        itemType: "reasoning",
        detail: "Check the actual source first",
      },
    },
    {
      id: EventId.make("tool"),
      kind: "tool.completed",
      summary: "Read source",
      tone: "tool",
      turnId: null,
      createdAt: at,
      payload: {
        agentId: "agent-a",
        timelineBypass: true,
        itemType: "command_execution",
        toolCallId: "tool-1",
        detail: "source contents",
        data: { item: { command: "cat source.ts" } },
      },
    },
    {
      id: EventId.make("sibling-tool"),
      kind: "tool.completed",
      summary: "Sibling output",
      tone: "tool",
      turnId: null,
      createdAt: at,
      payload: { agentId: "agent-b", toolCallId: "tool-1", detail: "unrelated output" },
    },
  ];
  const messages = [
    {
      id: MessageId.make("answer"),
      role: "assistant" as const,
      text: "Here is what the source does",
      agentId: "agent-a",
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  ];
  expect(deriveWorkLogEntries(activities)).toEqual([]);
  const scoped = selectAgentTranscript(messages, activities, "agent-a");
  const work = deriveWorkLogEntries(scoped.activities);
  expect(work).toHaveLength(1);
  expect(work[0]).toMatchObject({ detail: "source contents", command: "cat source.ts" });
  const timeline = deriveTimelineEntries(scoped.messages, [], work);
  expect(timeline).toHaveLength(2);
  expect(timeline.find((entry) => entry.kind === "message")).toMatchObject({
    message: { text: "Here is what the source does" },
  });
});
