import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { attachedSideChatsOf, isAttachedSideChat, visibleThreadShells } from "./sideChat.ts";

const chat = (
  id: string,
  options: { parent?: string; promoted?: boolean; environment?: string; createdAt?: string } = {},
) => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make(options.environment ?? "local"),
  createdAt: options.createdAt ?? "2026-09-08T00:00:00.000Z",
  forkedFromThreadId: options.parent ? ThreadId.make(options.parent) : null,
  sideChatPromotedAt: options.promoted ? "2026-09-09T00:00:00.000Z" : null,
});

describe("side chat visibility", () => {
  it("treats only unpromoted forks as attached side chats", () => {
    expect(isAttachedSideChat(chat("child", { parent: "parent" }))).toBe(true);
    expect(isAttachedSideChat(chat("child", { parent: "parent", promoted: true }))).toBe(false);
    expect(isAttachedSideChat(chat("plain"))).toBe(false);
  });
  it("hides attached side chats from lists and keeps the array identity otherwise", () => {
    const plain = [chat("a"), chat("b", { parent: "a", promoted: true })];
    expect(visibleThreadShells(plain)).toBe(plain);
    expect(visibleThreadShells([...plain, chat("c", { parent: "a" })])).toEqual(plain);
  });
  it("lists a parent's attached side chats oldest first, never crossing environments", () => {
    const parent = chat("parent");
    const newer = chat("newer", { parent: "parent", createdAt: "2026-09-09T00:00:00.000Z" });
    const older = chat("older", { parent: "parent" });
    expect(
      attachedSideChatsOf(parent, [
        newer,
        chat("promoted", { parent: "parent", promoted: true }),
        chat("remote", { parent: "parent", environment: "remote" }),
        older,
        chat("grandchild", { parent: "older" }),
      ]),
    ).toEqual([older, newer]);
  });
});
