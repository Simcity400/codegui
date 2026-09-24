import { selectAgentTranscript } from "@t3tools/client-runtime/state/agent-transcripts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { MessageId, TurnId } from "@t3tools/contracts";

import { buildThreadFeed } from "./threadActivity";

// Match Hermes: these ES2023 array methods are absent on mobile.
beforeEach(() => {
  const methods = ["toSorted", "toReversed"] as const;
  const descriptors = methods.map((method) =>
    Object.getOwnPropertyDescriptor(Array.prototype, method),
  );
  for (const method of methods) Reflect.deleteProperty(Array.prototype, method);
  return () => {
    for (const [index, method] of methods.entries()) {
      const descriptor = descriptors[index];
      if (descriptor) Reflect.defineProperty(Array.prototype, method, descriptor);
    }
  };
});

describe("buildThreadFeed", () => {
  it("keeps agent messages in their own transcript across streamed and paginated history", () => {
    const message = (id: string, agentId?: string) => ({
      id: MessageId.make(id),
      role: "assistant" as const,
      text: id,
      turnId: TurnId.make("turn-1"),
      streaming: true,
      createdAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:01.000Z",
      ...(agentId ? { agentId } : {}),
    });
    const messages = [message("root"), message("child", "agent-a"), message("sibling", "agent-b")];
    const thread = { messages, activities: [] };
    const messageIds = (feed: ReturnType<typeof buildThreadFeed>) =>
      feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : []));
    expect(messageIds(buildThreadFeed(thread))).toEqual(["root"]);
    expect(
      messageIds(
        buildThreadFeed(thread, {
          loadedMessages: [message("older-child", "agent-a"), ...messages],
          localMessages: [message("local-root")],
        }),
      ),
    ).toEqual(["root", "local-root"]);
    expect(messageIds(buildThreadFeed(selectAgentTranscript(messages, [], "agent-a")))).toEqual([
      "child",
    ]);
  });
});
