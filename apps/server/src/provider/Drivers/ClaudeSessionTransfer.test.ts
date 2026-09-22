import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { transferClaudeSession } from "./ClaudeSessionTransfer.ts";

const sessionId = "a9b37363-9b24-4d2f-a7c4-b075646b547a";
it.layer(NodeServices.layer)("Claude session transfer", (it) => {
  it.effect(
    "preserves native transcript, subagents and rewinds across account switches and back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-transfer-" });
        const work = path.join(root, "work");
        const personal = path.join(root, "personal");
        const project = "native-project-key-with-hash";
        const transcript = path.join("projects", project, `${sessionId}.jsonl`);
        const subagent = path.join("projects", project, sessionId, "subagents", "agent-abc.jsonl");
        const metadata = path.join(
          "projects",
          project,
          sessionId,
          "subagents",
          "agent-abc.meta.json",
        );
        const rewind = path.join("file-history", sessionId, "file-backup");
        const write = (home: string, relative: string, contents: string) =>
          Effect.gen(function* () {
            const target = path.join(home, relative);
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, contents);
          });
        yield* write(work, transcript, "original native context\n");
        yield* write(work, subagent, "subagent context\n");
        yield* write(work, metadata, '{"agentType":"researcher"}');
        yield* write(work, rewind, "original file contents");
        yield* write(work, ".credentials.json", "work credentials");
        yield* write(personal, ".credentials.json", "personal credentials");
        yield* write(personal, "settings.json", "personal settings");
        yield* write(work, path.join("projects", project, "another-session.jsonl"), "unrelated");
        yield* transferClaudeSession({
          sourceHome: work,
          targetHome: personal,
          resumeCursor: { resume: sessionId },
        });
        for (const relative of [transcript, subagent, metadata, rewind]) {
          expect(yield* fs.readFileString(path.join(personal, relative))).toBe(
            yield* fs.readFileString(path.join(work, relative)),
          );
        }
        expect(yield* fs.readFileString(path.join(personal, ".credentials.json"))).toBe(
          "personal credentials",
        );
        expect(yield* fs.readFileString(path.join(personal, "settings.json"))).toBe(
          "personal settings",
        );
        expect(
          yield* fs.exists(path.join(personal, "projects", project, "another-session.jsonl")),
        ).toBe(false);
        yield* write(personal, transcript, "original native context\nnew turn\n");
        yield* write(personal, subagent, "subagent context\nnew agent turn\n");
        yield* transferClaudeSession({
          sourceHome: personal,
          targetHome: work,
          resumeCursor: { sessionId },
        });
        expect(yield* fs.readFileString(path.join(work, transcript))).toBe(
          "original native context\nnew turn\n",
        );
        expect(yield* fs.readFileString(path.join(work, subagent))).toContain("new agent turn");
        expect(yield* fs.readFileString(path.join(work, ".credentials.json"))).toBe(
          "work credentials",
        );
      }),
  );

  it.effect(
    "fails without overwriting destination context when the source is missing or invalid",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-transfer-failure-" });
        const sourceHome = path.join(root, "source");
        const targetHome = path.join(root, "target");
        yield* fs.makeDirectory(path.join(sourceHome, "projects"), { recursive: true });
        const target = path.join(targetHome, "projects", "project", `${sessionId}.jsonl`);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, "retained history");
        for (const resume of [sessionId, "../../auth", "", "not-a-session"]) {
          const error = yield* Effect.flip(
            transferClaudeSession({ sourceHome, targetHome, resumeCursor: { resume } }),
          );
          expect(error._tag).toBe("ProviderAdapterRequestError");
          expect(yield* fs.readFileString(target)).toBe("retained history");
        }
      }),
  );
});
