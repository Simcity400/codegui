import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
} from "../components/usage/usagePagePreferences";

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): { view?: "limits" } =>
    raw.view === "limits" ? { view: "limits" } : {},
  loaderDeps: ({ search }) => ({ view: search.view }),
  // `?view=limits` (the composer's context popover) lands on the Limits tab by
  // choosing it the same way the tab toggle does; without it the page opens on
  // the metric the user last picked. Intent preloads run loaders on link hover
  // and focus, and a hover is not a choice.
  loader: ({ deps, preload }) => {
    if (!preload && deps.view === "limits") {
      saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    }
  },
  component: UsageRoute,
});

function UsageRoute() {
  const { view } = Route.useSearch();
  return <UsagePage key={view ?? "default"} />;
}
