import { it } from "@effect/vitest";
import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import {
  type ClaudeSubagentTool,
  type ClaudeSubagentTranscriptContext,
  makeClaudeSubagentTranscript,
} from "./ClaudeSubagentTranscript.ts";

function makeTranscript() {
  const events: ProviderRuntimeEvent[] = [];
  const transcript = makeClaudeSubagentTranscript({
    makeEventStamp: () =>
      Effect.succeed({ eventId: EventId.make("event"), createdAt: "2026-01-01T00:00:00.000Z" }),
    offerRuntimeEvent: (event) => Effect.sync(() => void events.push(event)),
    classifyToolItemType: () => "command_execution",
    titleForTool: () => "Command run",
    summarizeToolRequest: (toolName) => toolName,
  });
  return { events, transcript };
}

const tool = (itemId: string, agentId?: string): ClaudeSubagentTool => ({
  itemId,
  itemType: "command_execution",
  toolName: "Bash",
  title: "Command run",
  input: {},
  partialInputJson: "",
  ...(agentId ? { agentId, parentToolUseId: `launch-${agentId}` } : {}),
});

function makeContext(liveTaskIds: ReadonlyArray<string>): ClaudeSubagentTranscriptContext {
  return {
    session: { threadId: ThreadId.make("thread") },
    turnState: { turnId: TurnId.make("turn") },
    inFlightTools: new Map([
      [0, tool("parent-tool")],
      [-1, tool("live-tool", "live-agent")],
      [-2, tool("ended-tool", "ended-agent")],
    ]),
    liveTaskIds: new Set(liveTaskIds),
  };
}

describe("makeClaudeSubagentTranscript", () => {
  it.effect("keeps a live background agent's tools open past the turn result", () =>
    Effect.gen(function* () {
      const { events, transcript } = makeTranscript();
      const context = makeContext(["live-agent"]);

      yield* transcript.closeTurnTools(context, "interrupted", { status: "interrupted" });

      assert.deepEqual(
        events.map((event) =>
          event.type === "item.completed"
            ? [event.itemId, event.payload.status, event.payload.agentId]
            : [event.type],
        ),
        [
          ["parent-tool", "failed", undefined],
          ["ended-tool", "failed", "ended-agent"],
        ],
      );
      assert.deepEqual(Array.from(context.inFlightTools.keys()), [-1]);
    }),
  );

  it.effect("closes only the ending task's tools", () =>
    Effect.gen(function* () {
      const { events, transcript } = makeTranscript();
      const context = makeContext(["live-agent"]);

      yield* transcript.closeTaskTools(
        context,
        { subtype: "task_notification", task_id: "live-agent" },
        "completed",
      );

      assert.equal(events.length, 1);
      const [closed] = events;
      assert.equal(closed?.itemId, "live-tool");
      if (closed?.type === "item.completed") {
        assert.equal(closed.payload.status, "completed");
        assert.equal(closed.raw?.method, "claude/system/task_notification");
      }
      assert.deepEqual(Array.from(context.inFlightTools.keys()), [0, -2]);
    }),
  );
});
