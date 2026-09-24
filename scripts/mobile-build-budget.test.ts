// @effect-diagnostics globalDate:off - Fixed timestamps exercise the standalone Node build gate.
import { describe, expect, it } from "vite-plus/test";
import {
  BUILD_COOLDOWN,
  BUILD_LIMIT,
  BUILD_WINDOW,
  parseIosBuildQuota,
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

  describe("with Expo's billing-period quota", () => {
    const quota = (used: number, limit = 15) => ({
      used,
      limit,
      periodEnd: "2026-10-01T00:00:00.000Z",
    });
    // Expo does not bill failed builds, so its count can sit below the attempts.
    const attempts = Array.from({ length: 16 }, (_, i) => build(String(i), (4 + i) * DAY));

    it("spends remaining quota even when the rolling attempt count is over the cap", () => {
      expect(planIosBuild(attempts, NOW).build).toBe(false);
      const plan = planIosBuild(attempts, NOW, false, quota(14));
      expect(plan.build).toBe(true);
      expect(plan.reason).toContain("14/15 iPhone builds used this Expo billing period");
    });

    it("stops at Expo's limit until the period resets, including urgent runs", () => {
      const plan = planIosBuild(attempts, NOW, true, quota(15));
      expect(plan.build).toBe(false);
      expect(plan.reason).toContain("Next eligible after 2026-10-01T00:00:00.000Z");
    });

    it("keeps the cooldown and the pending-build guard", () => {
      expect(planIosBuild([build("last", DAY)], NOW, false, quota(1)).build).toBe(false);
      expect(planIosBuild([build("last", DAY)], NOW, true, quota(1)).build).toBe(true);
      expect(planIosBuild([build("pending", 4 * DAY, "IN_QUEUE")], NOW, true, quota(1)).build).toBe(
        false,
      );
    });

    it("reads eas account:usage output and rejects anything else", () => {
      expect(
        parseIosBuildQuota({
          account: { billingPeriod: { end: "2026-10-01T00:00:00.000Z" } },
          builds: { ios: { plan: { used: 14, limit: 15 } } },
        }),
      ).toEqual(quota(14));
      for (const value of [
        null,
        {},
        {
          account: { billingPeriod: { end: "soon" } },
          builds: { ios: { plan: { used: 1, limit: 15 } } },
        },
        {
          account: { billingPeriod: { end: "2026-10-01" } },
          builds: { ios: { plan: { used: 1.5, limit: 15 } } },
        },
        {
          account: { billingPeriod: { end: "2026-10-01" } },
          builds: { ios: { plan: { used: "1", limit: 15 } } },
        },
      ]) {
        expect(() => parseIosBuildQuota(value)).toThrow("invalid iPhone build usage");
      }
    });
  });
});
