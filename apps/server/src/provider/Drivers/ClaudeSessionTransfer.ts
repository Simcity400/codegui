import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProviderAdapterRequestError } from "../Errors.ts";

const ResumeCursor = Schema.Struct({
  resume: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const decodeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isSessionId = Schema.is(Schema.String.check(Schema.isUUID()));

/** Transfer only this session's native history; account credentials stay in their own homes. */
export const transferClaudeSession = Effect.fn("transferClaudeSession")(function* (input: {
  readonly sourceHome: string | undefined;
  readonly targetHome: string;
  readonly resumeCursor: unknown;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string) =>
    new ProviderAdapterRequestError({
      provider: ProviderDriverKind.make("claudeAgent"),
      method: "session/transfer",
      detail,
    });
  const sourceHome = input.sourceHome;
  if (sourceHome === undefined)
    return yield* fail("The original Claude account's session home is unavailable.");
  if (path.resolve(sourceHome) === path.resolve(input.targetHome)) return;
  const cursor = decodeCursor(input.resumeCursor);
  const sessionId =
    cursor._tag === "Some" ? (cursor.value.resume ?? cursor.value.sessionId) : undefined;
  if (sessionId === undefined || !isSessionId(sessionId)) {
    return yield* fail("The existing Claude conversation has no valid session ID to transfer.");
  }
  const sourceProjects = path.join(sourceHome, "projects");
  yield* Effect.gen(function* () {
    // Preserve Claude's native project key, including its long-path hash and worktree lookup.
    const projects = yield* fs.readDirectory(sourceProjects);
    const matches = [];
    for (const project of projects) {
      const transcript = path.join(sourceProjects, project, `${sessionId}.jsonl`);
      if (yield* fs.exists(transcript)) matches.push(project);
    }
    if (matches.length !== 1) {
      return yield* fail(
        `Could not uniquely locate Claude session '${sessionId}' in the original account. Its existing context has been retained.`,
      );
    }
    const project = matches[0]!;
    const sourceProject = path.join(sourceProjects, project);
    const targetProject = path.join(input.targetHome, "projects", project);
    yield* fs.makeDirectory(targetProject, { recursive: true });
    // Stage the transcript before replacing the destination. A failed copy must
    // never leave a truncated transcript that a later retry might resume.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: targetProject,
          prefix: ".t3-transfer-",
        });
        const stagedTranscript = path.join(staging, `${sessionId}.jsonl`);
        yield* fs.copyFile(path.join(sourceProject, `${sessionId}.jsonl`), stagedTranscript);
        for (const [source, target] of [
          [path.join(sourceProject, sessionId), path.join(targetProject, sessionId)],
          [
            path.join(sourceHome, "file-history", sessionId),
            path.join(input.targetHome, "file-history", sessionId),
          ],
        ] as const) {
          if (yield* fs.exists(source)) {
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.copy(source, target, { overwrite: true });
          }
        }
        yield* fs.rename(stagedTranscript, path.join(targetProject, `${sessionId}.jsonl`));
      }),
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      fail(`Could not transfer Claude session '${sessionId}': ${cause.message}`),
    ),
  );
});
