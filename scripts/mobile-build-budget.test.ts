// @effect-diagnostics globalDate:off - Fixed timestamps exercise the standalone Node build gate.
import { describe, expect, it } from "vite-plus/test";
import {
  BUILD_COOLDOWN,
  BUILD_LIMIT,
  BUILD_WINDOW,
  parseIosBuilds,
  planIosBuild,
  readIosBuildHistory,
} from "./mobile-build-budget.ts";

const NOW = Date.parse("2026-09-20T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const build = (id: string, age: number, status = "FINISHED") => ({
  id,
  platform: "IOS",
  createdAt: new Date(NOW - age).toISOString(),
  status,
});

describe("iPhone native build budget", () => {
  it("allows the first build without requiring a manual bootstrap", () => {
    expect(planIosBuild([], NOW).build).toBe(true);
  });

  it("waits a full three days and automatically becomes eligible at the boundary", () => {
    const history = [build("last", BUILD_COOLDOWN - 1)];
    expect(planIosBuild(history, NOW)).toMatchObject({ build: false });
    expect(planIosBuild(history, NOW).reason).toContain("three-day cooldown");
    expect(planIosBuild(history, NOW + 1).build).toBe(true);
  });

  it("permits an urgent build inside the cooldown", () => {
    expect(planIosBuild([build("last", DAY)], NOW, true).build).toBe(true);
  });

  it("allows the twelfth attempt but blocks the thirteenth, including urgent runs", () => {
    const history = Array.from({ length: BUILD_LIMIT }, (_, i) => build(String(i), (4 + i) * DAY));
    expect(planIosBuild(history.slice(1), NOW).build).toBe(true);
    expect(planIosBuild(history, NOW).build).toBe(false);
    expect(planIosBuild(history, NOW, true).build).toBe(false);
    expect(planIosBuild(history, NOW).reason).toContain("12/12");
  });

  it("counts failures and cancellations conservatively instead of retrying them repeatedly", () => {
    expect(planIosBuild([build("failed", DAY, "ERRORED")], NOW).build).toBe(false);
    const history = Array.from({ length: BUILD_LIMIT }, (_, i) =>
      build(String(i), 4 * DAY, i % 2 ? "ERRORED" : "CANCELED"),
    );
    expect(planIosBuild(history, NOW, true).build).toBe(false);
  });

  it.each(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"])(
    "never duplicates an outstanding %s build, even after a workflow timeout",
    (status) => {
      expect(planIosBuild([build("pending", 4 * DAY, status)], NOW, true).build).toBe(false);
    },
  );

  it("uses a rolling window across month boundaries and releases capacity automatically", () => {
    const history = Array.from({ length: BUILD_LIMIT }, (_, i) =>
      build(String(i), BUILD_WINDOW - 1 - i * DAY),
    );
    expect(planIosBuild(history, NOW).build).toBe(false);
    expect(planIosBuild(history, NOW + 1).build).toBe(true);
  });

  it("finds the correct next slot even when previous manual builds exceeded the cap", () => {
    const history = Array.from({ length: 15 }, (_, i) => build(String(i), (4 + i) * DAY));
    const nextSlot = NOW + 16 * DAY;
    expect(planIosBuild(history, NOW).reason).toContain(new Date(nextSlot).toISOString());
    expect(planIosBuild(history, nextSlot - 1).build).toBe(false);
    expect(planIosBuild(history, nextSlot).build).toBe(true);
  });

  it("uses the latest attempt regardless of input order", () => {
    expect(planIosBuild([build("old", 10 * DAY), build("new", DAY)], NOW).build).toBe(false);
  });

  it("loads all history pages so older attempts cannot disappear behind a page limit", () => {
    const history = Array.from({ length: 53 }, (_, i) => build(String(i), i * DAY));
    const offsets: number[] = [];
    const loaded = readIosBuildHistory((offset, limit) => {
      offsets.push(offset);
      return history.slice(offset, offset + limit);
    });
    expect(offsets).toEqual([0, 50]);
    expect(loaded).toHaveLength(53);
    expect(planIosBuild(loaded, NOW, true).build).toBe(false);
  });

  it("does not assume an unavailable, malformed, or changing history means zero usage", () => {
    expect(() =>
      readIosBuildHistory(() => {
        throw new Error("Expo unavailable");
      }),
    ).toThrow("Expo unavailable");
    for (const value of [
      null,
      {},
      [{ ...build("bad", DAY), createdAt: "invalid" }],
      [{ ...build("bad", DAY), status: "UNKNOWN" }],
      [{ ...build("bad", DAY), platform: "ANDROID" }],
    ]) {
      expect(() => parseIosBuilds(value)).toThrow();
    }
    const page = Array.from({ length: 50 }, (_, i) => build(String(i), i * DAY));
    expect(() => readIosBuildHistory(() => page)).toThrow("changed during pagination");
  });
});
