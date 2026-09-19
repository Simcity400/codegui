// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Standalone GitHub Actions gate using only Node and the installed EAS CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DAY = 24 * 60 * 60 * 1_000;
export const BUILD_COOLDOWN = 3 * DAY;
export const BUILD_WINDOW = 31 * DAY;
export const BUILD_LIMIT = 12;
const PAGE_SIZE = 50;
const SETTLED_STATUSES = new Set(["FINISHED", "ERRORED", "CANCELED"]);
const BUILD_STATUSES = new Set([
  ...SETTLED_STATUSES,
  "NEW",
  "IN_QUEUE",
  "IN_PROGRESS",
  "PENDING_CANCEL",
]);

interface IosBuild {
  readonly id: string;
  readonly createdAt: string;
  readonly status: string;
}

/** Invalid or incomplete history must never grant permission to spend a build. */
export function parseIosBuilds(value: unknown): IosBuild[] {
  if (!Array.isArray(value)) throw new Error("EAS did not return a build list.");
  return value.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      !("platform" in entry) ||
      entry.platform !== "IOS" ||
      !("createdAt" in entry) ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !("status" in entry) ||
      typeof entry.status !== "string" ||
      !BUILD_STATUSES.has(entry.status)
    )
      throw new Error("EAS returned an invalid iPhone build record.");
    return { id: entry.id, createdAt: entry.createdAt, status: entry.status };
  });
}

/** Include every profile and outcome, not just successful preview builds. */
export function readIosBuildHistory(
  loadPage: (offset: number, limit: number) => unknown,
): IosBuild[] {
  const builds: IosBuild[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = parseIosBuilds(loadPage(offset, PAGE_SIZE));
    for (const build of page) {
      if (seen.has(build.id))
        throw new Error("EAS build history changed during pagination; retry the workflow.");
      seen.add(build.id);
      builds.push(build);
    }
    if (page.length < PAGE_SIZE) return builds;
  }
}

export function planIosBuild(
  builds: ReadonlyArray<IosBuild>,
  now: number,
  urgent = false,
): { build: boolean; reason: string } {
  if (!Number.isFinite(now)) throw new Error("Invalid budget check time.");
  if (builds.some((build) => !SETTLED_STATUSES.has(build.status))) {
    return {
      build: false,
      reason: "An iPhone build is already pending. The daily check will retry after it settles.",
    };
  }
  // A rolling window avoids assuming Expo's billing-cycle start date. Counting
  // failed and canceled attempts conservatively also prevents retry storms.
  const recent = builds
    .map((build) => Date.parse(build.createdAt))
    .filter((createdAt) => createdAt > now - BUILD_WINDOW)
    .sort((a, b) => b - a);
  const latest = recent[0];
  const cooldownEnds = latest === undefined ? now : latest + BUILD_COOLDOWN;
  if (recent.length >= BUILD_LIMIT) {
    const budgetOpens = recent[BUILD_LIMIT - 1]! + BUILD_WINDOW;
    const retryAt = urgent ? budgetOpens : Math.max(budgetOpens, cooldownEnds);
    return {
      build: false,
      reason: `Native update deferred: ${recent.length}/${BUILD_LIMIT} iPhone build attempts in the last 31 days. Next eligible after ${new Date(retryAt).toISOString()}. The daily check will retry automatically.`,
    };
  }
  if (!urgent && cooldownEnds > now) {
    return {
      build: false,
      reason: `Native update deferred until ${new Date(cooldownEnds).toISOString()} (three-day cooldown). The daily check will retry automatically.`,
    };
  }
  return {
    build: true,
    reason: `Native build allowed: ${recent.length}/${BUILD_LIMIT} attempts in the last 31 days.${urgent ? " Urgent run bypasses the cooldown, but keeps the budget cap." : ""}`,
  };
}

if (import.meta.main) {
  const compatibleBuild = process.env.COMPATIBLE_IOS_BUILD_ID;
  const plan = compatibleBuild
    ? {
        build: false,
        reason: "A compatible iPhone build already exists; no native build is needed.",
      }
    : planIosBuild(
        readIosBuildHistory((offset, limit) =>
          JSON.parse(
            NodeChildProcess.execFileSync(
              "eas",
              [
                "build:list",
                "--platform",
                "ios",
                "--offset",
                String(offset),
                "--limit",
                String(limit),
                "--json",
                "--non-interactive",
              ],
              { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 120_000 },
            ),
          ),
        ),
        Date.now(),
        process.env.URGENT_NATIVE_BUILD === "true",
      );
  console.log(plan.reason);
  if (process.env.GITHUB_OUTPUT) {
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `build=${plan.build}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### iPhone native build budget\n\n${plan.reason}\n\n` +
        "Compatible over-the-air updates remain automatic. A deferred native change reaches your phone only after a new build is available and installed.\n",
    );
  }
}
