import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  claimPreviewRecording,
  normalizePreviewOpenInput,
  PreviewStandardToolkitHandlersLive,
} from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

it.effect("keeps the laptop browser after an optional icon lookup times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.make;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("tower-environment"),
        threadId: ThreadId.make("discord-setup"),
        providerSessionId: "agent-on-tower",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
        issuedAt: 1,
      };
      const laptopTabId = PreviewTabId.make("laptop-discord");
      const laptopConnected = yield* Deferred.make<void>();
      const laptopDisconnected = yield* Deferred.make<void>();
      const towerConnected = yield* Deferred.make<void>();
      const delayedStatus = yield* Deferred.make<{
        connectionId: PreviewAutomationStreamEvent["connectionId"];
        request: PreviewAutomationRequest;
      }>();
      const laptopRequests: PreviewAutomationRequest[] = [];
      const towerRequests: PreviewAutomationRequest[] = [];
      let delayStatus = true;
      const status = {
        available: true,
        visible: true,
        loading: false,
        tabId: laptopTabId,
        title: "Discord on laptop",
        url: "https://discord.com/channels/server/general",
      };
      const laptop = yield* broker.connect({
        clientId: "laptop",
        environmentId: scope.environmentId,
      });
      yield* Stream.runForEach(laptop, (event) => {
        if (event.type === "connected") return Deferred.succeed(laptopConnected, undefined);
        laptopRequests.push(event.request);
        if (event.request.operation === "status" && delayStatus) {
          delayStatus = false;
          return Deferred.succeed(delayedStatus, {
            connectionId: event.connectionId,
            request: event.request,
          });
        }
        return broker.respond({
          clientId: "laptop",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "evaluate"
              ? "Discord on laptop"
              : event.request.operation === "click"
                ? {}
                : status,
        });
      }).pipe(Effect.ensuring(Deferred.succeed(laptopDisconnected, undefined)), Effect.forkScoped);
      yield* Deferred.await(laptopConnected);
      yield* broker.invoke({ scope, operation: "open", input: {} });

      const tower = yield* broker.connect({
        clientId: "tower",
        environmentId: scope.environmentId,
      });
      yield* Stream.runForEach(tower, (event) => {
        if (event.type === "connected") return Deferred.succeed(towerConnected, undefined);
        towerRequests.push(event.request);
        return broker.respond({
          clientId: "tower",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: event.request.operation === "evaluate" ? "Discord on tower" : {},
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(towerConnected);

      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(PreviewStandardToolkitHandlersLive),
      );
      const call = <Name extends keyof typeof PreviewStandardToolkit.tools>(
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit
          .handle(name, params)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          );
      const click = yield* call("preview_click", { locator: "text=Settings" }).pipe(
        Effect.forkScoped,
      );
      const late = yield* Deferred.await(delayedStatus);
      yield* TestClock.adjust(500);
      expect((yield* Fiber.join(click)).at(-1)?.result).toEqual({});

      // A late icon response must not move the selected tab or replay the click.
      yield* broker.respond({
        clientId: "laptop",
        connectionId: late.connectionId,
        requestId: late.request.requestId,
        ok: true,
        result: { ...status, tabId: PreviewTabId.make("unrelated-tab") },
      });
      const page = yield* call("preview_evaluate", { expression: "document.title" });
      expect(page.at(-1)?.result).toMatchObject({ value: "Discord on laptop" });
      expect(towerRequests).toEqual([]);
      expect(laptopRequests.filter((request) => request.operation === "click")).toHaveLength(1);
      expect(laptopRequests.at(-1)?.tabId).toBe(laptopTabId);
      expect(yield* Deferred.isDone(laptopDisconnected)).toBe(false);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-routing-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ),
);

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports an older desktop without returning its inaccessible path", () =>
    Effect.gen(function* () {
      const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationRecordingDesktopUpdateRequiredError");
      expect(result.failure.message).toContain("Update the desktop app");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
