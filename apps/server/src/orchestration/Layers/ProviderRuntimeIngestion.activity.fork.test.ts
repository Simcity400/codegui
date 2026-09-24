import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task background flag", () => {
  it("persists isBackgrounded on start, patch, and terminal rows", () => {
    const taskId = RuntimeTaskId.make("shell-1");
    const started = {
      ...base,
      type: "task.started",
      eventId: EventId.make("evt-start"),
      payload: { taskId, description: "Run gates", taskType: "local_bash", isBackgrounded: false },
    } satisfies ProviderRuntimeEvent;
    const backgrounded = {
      ...base,
      type: "task.updated",
      eventId: EventId.make("evt-bg"),
      payload: { taskId, taskType: "local_bash", isBackgrounded: true },
    } satisfies ProviderRuntimeEvent;
    const completed = {
      ...base,
      type: "task.completed",
      eventId: EventId.make("evt-done"),
      payload: { taskId, status: "completed", taskType: "local_bash", isBackgrounded: true },
    } satisfies ProviderRuntimeEvent;

    const payloads = [started, backgrounded, completed].map(
      (event) => runtimeEventToActivities(event)[0]?.payload as Record<string, unknown>,
    );
    expect(payloads.map((payload) => payload.isBackgrounded)).toEqual([false, true, true]);
    expect(payloads.map((payload) => payload.agentKind)).toEqual([
      "background",
      "background",
      "background",
    ]);
  });
});
