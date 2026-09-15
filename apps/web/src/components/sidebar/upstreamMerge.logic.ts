import type { DesktopUpstreamMergeStatus } from "@t3tools/contracts";

// Text for the personal fork's blocked-sync notice (SidebarUpstreamMergeNotice).
// The desktop updater fills `upstreamMerge` from the marker Fork Sync pushes
// when an official nightly cannot be merged on its own.

export function describeUpstreamMerge(status: DesktopUpstreamMergeStatus): string {
  const count = status.conflicts.length;
  if (count === 0) {
    return `Official nightly ${status.tag} could not be merged. ${status.reason ?? "Read the run log."}`;
  }
  return `Official nightly ${status.tag} conflicts with your customizations in ${count} ${
    count === 1 ? "file" : "files"
  }.`;
}

/** A self-contained repair prompt so the update can be handled inside T3. */
export function buildUpstreamMergePrompt(status: DesktopUpstreamMergeStatus): string {
  const lines = [
    `Finish the upstream merge: integrate the official nightly ${status.tag} into main of the fork ${status.repository}.`,
    "Work in a clean, isolated checkout of the current fork main. Fetch the published upstream tag, resolve conflicts preserving both upstream fixes and the fork customizations, and retain the fork-owned workflows.",
    "Update fork-upstream.json with the integrated tag and commit. Run focused tests and typechecks for the affected packages, obtain a review, then publish the repaired main and verify the personal release workflow. Keep progress and any decisions in this T3 thread.",
  ];
  if (status.commit) lines.push(`Upstream commit: ${status.commit}`);
  if (status.conflicts.length > 0) {
    lines.push("Conflicting files:", ...status.conflicts.map((path) => `- ${path}`));
  } else if (status.reason) {
    lines.push(`The sync stopped before merging: ${status.reason}`);
  }
  if (status.runUrl) lines.push(`Failed run: ${status.runUrl}`);
  return lines.join("\n");
}
