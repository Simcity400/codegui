import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, ThreadId, type DirectPushRegistration } from "@t3tools/contracts";
import {
  directActivityMessage,
  directPushAggregate,
  directPushAlert,
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
  it("allows the same terminal phase on a later turn", () => {
    expect(directPushAlert(thread("completed"), thread("completed", "turn-2"))).not.toBeNull();
  });
  it("prioritizes active work, bounds the card, and omits private failure detail", () => {
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
    expect(aggregate?.activities[0]?.phase).toBe("running");
    expect(JSON.stringify(aggregate)).not.toContain("Private error details");
  });
  it("updates the Expo widget payload and ends it with final content when work finishes", () => {
    const running = directPushAggregate([thread("running")], now);
    const update = directActivityMessage(device, running, now);
    expect(update?.payload).toMatchObject({
      aps: {
        event: "update",
        "content-state": { name: "AgentActivity", props: JSON.stringify(running) },
      },
    });
    const done = directPushAggregate([thread("completed")], now);
    expect(directActivityMessage(device, done, now)?.payload).toMatchObject({
      aps: {
        event: "end",
        "dismissal-date": Math.floor(now / 1000) + 900,
        "content-state": { props: JSON.stringify(done) },
      },
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
