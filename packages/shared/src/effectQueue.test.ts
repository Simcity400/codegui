/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Separate runtimes force a yield between a queue's readiness check and waiter registration. */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import type * as Scheduler from "effect/Scheduler";

// Reproduce a scheduler yield between checking a queue and registering its
// waiter. This stranded the Codex stdout handoff with both sides waiting.
function yieldBeforeWaiting() {
  const tasks: Array<() => void> = [];
  let yielded = false;
  const flush = () => {
    while (tasks.length > 0) tasks.shift()!();
  };
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      if (!yielded && fiber.currentOpCount === 2) {
        yielded = true;
        return true;
      }
      return false;
    },
    makeDispatcher: () => ({ scheduleTask: (task) => tasks.push(task), flush }),
  };
  return { scheduler, flush };
}

describe("Effect queue scheduler races", () => {
  it.each(["single", "batch"] as const)(
    "delivers a %s offer when a receiver arrives before waiter registration",
    (mode) => {
      const queue = Effect.runSync(Queue.bounded<string>(0));
      const { scheduler, flush } = yieldBeforeWaiting();
      const producer =
        mode === "single"
          ? Effect.runFork(Queue.offer(queue, "message"), { scheduler })
          : Effect.runFork(Queue.offerAll(queue, ["message"]), { scheduler });
      const consumer = Effect.runFork(Queue.take(queue));
      try {
        flush();
        queue.dispatcher.flush();
        expect(consumer.pollUnsafe()).toEqual(Exit.succeed("message"));
        expect(producer.pollUnsafe()).toEqual(Exit.succeed(mode === "single" ? true : []));
        expect(Queue.sizeUnsafe(queue)).toBe(0);
      } finally {
        producer.interruptUnsafe();
        consumer.interruptUnsafe();
      }
    },
  );

  it.each([0, 1])(
    "receives a message offered before waiter registration with capacity %i",
    (capacity) => {
      const queue = Effect.runSync(Queue.bounded<string>(capacity));
      const { scheduler, flush } = yieldBeforeWaiting();
      const consumer = Effect.runFork(Queue.take(queue), { scheduler });
      const producer = Effect.runFork(Queue.offer(queue, "message"));
      try {
        flush();
        queue.dispatcher.flush();
        expect(consumer.pollUnsafe()).toEqual(Exit.succeed("message"));
        expect(producer.pollUnsafe()).toEqual(Exit.succeed(true));
        expect(Queue.sizeUnsafe(queue)).toBe(0);
      } finally {
        producer.interruptUnsafe();
        consumer.interruptUnsafe();
      }
    },
  );

  it("uses capacity freed before a blocked producer registers", () => {
    const queue = Effect.runSync(Queue.bounded<string>(1));
    Effect.runSync(Queue.offer(queue, "first"));
    const { scheduler, flush } = yieldBeforeWaiting();
    const producer = Effect.runFork(Queue.offer(queue, "second"), { scheduler });
    try {
      expect(Effect.runSync(Queue.take(queue))).toBe("first");
      flush();
      queue.dispatcher.flush();
      expect(producer.pollUnsafe()).toEqual(Exit.succeed(true));
      expect(Effect.runSync(Queue.take(queue))).toBe("second");
      expect(Queue.sizeUnsafe(queue)).toBe(0);
    } finally {
      producer.interruptUnsafe();
    }
  });

  it("preserves batch order when capacity changes before registration", () => {
    const queue = Effect.runSync(Queue.bounded<string>(1));
    Effect.runSync(Queue.offer(queue, "first"));
    const { scheduler, flush } = yieldBeforeWaiting();
    const producer = Effect.runFork(Queue.offerAll(queue, ["second", "third"]), { scheduler });
    try {
      expect(Effect.runSync(Queue.take(queue))).toBe("first");
      flush();
      queue.dispatcher.flush();
      expect(producer.pollUnsafe()).toBeUndefined();
      expect(Effect.runSync(Queue.take(queue))).toBe("second");
      expect(producer.pollUnsafe()).toEqual(Exit.succeed([]));
      expect(Effect.runSync(Queue.take(queue))).toBe("third");
      expect(Queue.sizeUnsafe(queue)).toBe(0);
    } finally {
      producer.interruptUnsafe();
    }
  });
});
