import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const commands = vi.hoisted(() => ({ set: vi.fn(), clear: vi.fn(), toast: vi.fn() }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { setCodexGoal: "set", clearCodexGoal: "clear" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "set" | "clear") => commands[command],
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: commands.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("./CodexGoalBanner", () => ({
  buildCodexGoalBannerItem: () => null,
  CodexGoalClearDialog: () => null,
  CodexGoalEditorDialog: () => null,
}));

import { useCodexGoalControls } from "./useCodexGoalControls";

function pendingCommand() {
  let resolve!: (value: { _tag: "Success" }) => void;
  const promise = new Promise<{ _tag: "Success" }>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let root: Root;
let controls: ReturnType<typeof useCodexGoalControls>;
function Probe({ id }: { id: string }) {
  const threadId = ThreadId.make(id);
  const state = useCodexGoalControls({
    environmentId: EnvironmentId.make("environment-1"),
    routeThreadKey: id,
    activeThreadKey: id,
    activeThreadId: threadId,
    isServerThread: true,
    codexGoal: null,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-08T00:00:00Z",
    },
  });
  useLayoutEffect(() => {
    controls = state;
  });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root.render(<Probe id="thread-a" />));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("goal controls across thread navigation", () => {
  it("leaves ordinary messages on the synchronous send path", () => {
    const clearDraft = vi.fn();
    expect(controls.handleGoalCommand("ordinary message", clearDraft)).toBe(false);
    expect(commands.set).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("keeps a pending operation scoped to its original thread", async () => {
    const completion = pendingCommand();
    commands.set.mockReturnValue(completion.promise);
    const clearDraft = vi.fn();
    let pending: boolean | Promise<boolean> = false;
    await act(() => {
      pending = controls.handleGoalCommand("/goal Ship it", clearDraft);
    });
    expect(controls.goalCommandRunning).toBe(true);
    await act(() => root.render(<Probe id="thread-b" />));
    expect(controls.goalCommandRunning).toBe(false);
    await act(async () => {
      completion.resolve({ _tag: "Success" });
      await pending;
    });
    expect(clearDraft).not.toHaveBeenCalled();
    expect(commands.set.mock.calls[0]?.[0].input.threadId).toBe("thread-a");
    expect(commands.toast).not.toHaveBeenCalled();
  });

  it("blocks duplicate goal mutations and clears the draft after success", async () => {
    const completion = pendingCommand();
    commands.set.mockReturnValue(completion.promise);
    const clearDraft = vi.fn();
    const duplicateClear = vi.fn();
    let pending: boolean | Promise<boolean> = false;
    await act(() => {
      pending = controls.handleGoalCommand("/goal Ship it", clearDraft);
    });
    await act(async () => {
      await controls.handleGoalCommand("/goal pause", duplicateClear);
    });
    expect(commands.set).toHaveBeenCalledTimes(1);
    expect(duplicateClear).not.toHaveBeenCalled();
    await act(async () => {
      completion.resolve({ _tag: "Success" });
      await pending;
    });
    expect(controls.goalCommandRunning).toBe(false);
    expect(clearDraft).toHaveBeenCalledOnce();
  });
});
