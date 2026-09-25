import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, ThreadId, type DirectPushRegistration } from "@t3tools/contracts";
import {
  directActivityMessage,
  directPushAggregate,
  directPushAlert,
  directPushThread,
  type DirectPushThread,
} from "./directPushState.ts";

const now = 1789900000000;
function thread(phase: DirectPushThread["state"]["phase"], turnId = "turn-1"): DirectPushThread {
  return {
    turnId,
    state: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      projectTitle: "Project",
      threadTitle: "Test task",
      modelTitle: "Codex",
      phase,
      headline: "Test",
      detail: "Private error details",
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      deepLink: "/threads/env-1/thread-1",
    },
  };
}
const device: DirectPushRegistration = {
  deviceId: "phone",
  bundleId: "com.example.app",
  apsEnvironment: "production",
  pushToken: "a".repeat(64),
  activityPushToken: "b".repeat(64),
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
};

describe("direct Apple push payloads", () => {
  it("keeps a finished turn with live background work on the card as Monitoring", () => {
    const done = thread("completed");
    const latestTurn = { turnId: "turn-1" };
    const monitoring = directPushThread(done.state, { latestTurn, backgroundLiveness: "working" });
    expect(directPushAggregate([monitoring], now)).toMatchObject({
      activeCount: 1,
      activities: [{ phase: "running", status: "Monitoring" }],
    });
    // No "finished" alert while it waits; one when the background work ends.
    expect(directPushAlert(thread("running"), monitoring)).toBeNull();
    const finished = directPushThread(done.state, { latestTurn, backgroundLiveness: null });
    expect(directPushAlert(monitoring, finished)?.aps.alert.title).toBe("Agent finished");
    expect(directPushAggregate([finished], now)?.activities[0]?.status).toBe("Done");
  });
  it("alerts once for completion, failure, approval and input transitions", () => {
    for (const phase of [
      "completed",
      "failed",
      "waiting_for_approval",
      "waiting_for_input",
    ] as const) {
      const next = thread(phase);
      expect(directPushAlert(thread("running"), next)?.aps.sound).toBe("default");
      expect(directPushAlert(next, next)).toBeNull();
      // A fast new thread can finish before its first queued snapshot is read.
      expect(directPushAlert(undefined, next)?.aps.sound).toBe("default");
    }
    expect(directPushAlert(thread("starting"), thread("running"))).toBeNull();
  });
  it("carries the thread where the iPhone app reads a tapped alert's data", () => {
    expect(directPushAlert(thread("running"), thread("completed"))?.body).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
    });
  });
  it("allows the same terminal phase on a later turn", () => {
    expect(directPushAlert(thread("completed"), thread("completed", "turn-2"))).not.toBeNull();
  });
  it("puts waiting work first, bounds the card, and omits private failure detail", () => {
    const aggregate = directPushAggregate(
      [
        thread("completed"),
        thread("running"),
        thread("failed"),
        thread("waiting_for_input"),
        thread("running"),
      ],
      now,
    );
    expect(aggregate?.activeCount).toBe(3);
    expect(aggregate?.activities).toHaveLength(4);
    expect(aggregate?.activities.map((row) => row.phase).slice(0, 3)).toEqual([
      "waiting_for_input",
      "running",
      "running",
    ]);
    expect(JSON.stringify(aggregate)).not.toContain("Private error details");
  });
  it("updates the Expo widget payload and keeps showing Done until the card ends", () => {
    const running = directPushAggregate([thread("running")], now);
    const update = directActivityMessage(device, running, now);
    expect(update?.priority).toBe(5);
    expect(update?.payload).toMatchObject({
      aps: {
        event: "update",
        "content-state": { name: "AgentActivity", props: JSON.stringify(running) },
      },
    });
    const done = directPushAggregate([thread("completed")], now);
    expect(directActivityMessage(device, done, now)).toMatchObject({
      priority: 10,
      payload: { aps: { event: "update", "content-state": { props: JSON.stringify(done) } } },
    });
    expect(directActivityMessage(device, null, now)?.payload).toMatchObject({
      aps: { event: "end", "dismissal-date": Math.floor(now / 1000) },
    });
    expect(
      directActivityMessage({ ...device, liveActivitiesEnabled: false }, running, now)?.payload,
    ).toMatchObject({ aps: { event: "end", "dismissal-date": Math.floor(now / 1000) } });
    expect(directActivityMessage({ ...device, activityPushToken: null }, running, now)).toBeNull();
  });
  it("expires finished rows after fifteen minutes", () => {
    expect(directPushAggregate([thread("completed")], now + 900001)).toBeNull();
  });
});
