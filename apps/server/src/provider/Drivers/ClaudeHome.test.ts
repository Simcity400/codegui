// @effect-diagnostics nodeBuiltinImport:off - Node's symlink API supports Windows junction fixtures without symlink privileges.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves the configured Claude directory and keeps capability caches separate", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("uses the default Claude config directory for continuation", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const explicit = { homePath: path.join(NodeOS.homedir(), ".claude") };

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, {})).toBe(
          yield* makeClaudeContinuationGroupKey(explicit, {}),
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR unless the instance overrides it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const homePath = path.join(root, "account");
        const env = { CLAUDE_CONFIG_DIR: homePath };
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, env)).toBe(
          yield* makeClaudeContinuationGroupKey({ homePath }, {}),
        );
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath }, { CLAUDE_CONFIG_DIR: root }),
        ).toBe(yield* makeClaudeContinuationGroupKey({ homePath }, {}));
      }),
    );

    it.effect("does not equate relative environment paths with paths under the server cwd", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = { homePath: "" };
        const relative = yield* makeClaudeContinuationGroupKey(config, {
          CLAUDE_CONFIG_DIR: "./account",
        });
        expect(relative).not.toBe(
          yield* makeClaudeContinuationGroupKey({ homePath: path.resolve("account") }, {}),
        );
        expect(relative).toBe(
          yield* makeClaudeContinuationGroupKey(config, { CLAUDE_CONFIG_DIR: "account" }),
        );
      }),
    );

    it.effect("allows account switches through shared projects without sharing credentials", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const first = { homePath: path.join(root, "first") };
        const second = { homePath: path.join(root, "second") };
        const projects = path.join(first.homePath, "projects");
        yield* fs.makeDirectory(projects, { recursive: true });
        yield* fs.makeDirectory(second.homePath);
        yield* Effect.promise(() =>
          NodeFSP.symlink(projects, path.join(second.homePath, "projects"), "junction"),
        );
        yield* fs.writeFileString(path.join(projects, "session.jsonl"), "saved conversation");

        expect(yield* makeClaudeContinuationGroupKey(first, {})).toBe(
          yield* makeClaudeContinuationGroupKey(second, {}),
        );
        expect(
          yield* fs.readFileString(path.join(second.homePath, "projects", "session.jsonl")),
        ).toBe("saved conversation");
        expect((yield* makeClaudeEnvironment(first, {})).CLAUDE_CONFIG_DIR).toBe(first.homePath);
        expect((yield* makeClaudeEnvironment(second, {})).CLAUDE_CONFIG_DIR).toBe(second.homePath);
      }),
    );

    it.effect(
      "keeps separate conversation directories incompatible, including before creation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
          const first = { homePath: path.join(root, "first") };
          const second = { homePath: path.join(root, "second") };
          expect(yield* makeClaudeContinuationGroupKey(first, {})).not.toBe(
            yield* makeClaudeContinuationGroupKey(second, {}),
          );
          yield* fs.makeDirectory(path.join(first.homePath, "projects"), { recursive: true });
          yield* fs.makeDirectory(path.join(second.homePath, "projects"), { recursive: true });
          expect(yield* makeClaudeContinuationGroupKey(first, {})).not.toBe(
            yield* makeClaudeContinuationGroupKey(second, {}),
          );
        }),
    );
  });
});
