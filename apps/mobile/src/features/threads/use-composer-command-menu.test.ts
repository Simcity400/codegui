import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  it("offers one native Goal command for existing Codex threads and inserts it", () => {
    const items = buildComposerSlashCommandItems({
      query: "go",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [{ name: "goal", description: "Native goal" }],
      },
    });
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item) throw new Error("Expected /goal");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/go",
        trigger: { rangeStart: 0, rangeEnd: 3 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "/goal ", cursor: 6, interactionMode: null });
  });

  it.each([
    { hasThread: false, atMessageStart: true },
    { hasThread: true, atMessageStart: false },
  ])("hides Codex /goal outside an existing thread's command position: %j", (position) => {
    expect(
      buildComposerSlashCommandItems({
        query: "goal",
        ...position,
        allowInteractionMode: true,
        selectedProviderStatus: {
          driver: ProviderDriverKind.make("codex"),
          slashCommands: [{ name: "goal" }],
        },
      }),
    ).toEqual([]);
  });

  it("leaves another provider's native /goal command alone", () => {
    const items = buildComposerSlashCommandItems({
      query: "goal",
      atMessageStart: true,
      hasThread: false,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("claudeAgent"),
        slashCommands: [{ name: "goal", description: "Provider command" }],
      },
    });
    expect(items.map((item) => item.description)).toEqual(["Provider command"]);
  });

  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("side chat command", () => {
  it.each(["codex", "claudeAgent"])(
    "offers a local command for an existing %s thread",
    (driver) => {
      const input = {
        query: "side",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode: false,
        selectedProviderStatus: { driver: ProviderDriverKind.make(driver), slashCommands: [] },
      };
      const item = buildComposerSlashCommandItems(input)[0];
      expect(item?.label).toBe("/side");
      if (!item) throw new Error("Missing side command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/si",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode: false,
        }),
      ).toEqual({ text: "/side ", cursor: 6, interactionMode: null });
      expect(buildComposerSlashCommandItems({ ...input, hasThread: false })).toEqual([]);
      expect(buildComposerSlashCommandItems({ ...input, atMessageStart: false })).toEqual([]);
    },
  );
  it("does not advertise a fork for unsupported providers", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "side",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode: false,
        selectedProviderStatus: { driver: ProviderDriverKind.make("cursor"), slashCommands: [] },
      }),
    ).toEqual([]);
  });
});
