import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { parseSideChatSlashCommand } from "@t3tools/shared/composerTrigger";
import { useLayoutEffect, useRef } from "react";
import { Alert } from "react-native";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";

export function useSideChatControls(
  environmentId: EnvironmentId,
  parent: OrchestrationThreadShell,
  provider: string | undefined,
) {
  const navigation = useNavigation();
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const busy = useRef(false);
  const parentKey = scopedThreadKey(environmentId, parent.id);
  const currentThread = useRef<string | null>(parentKey);
  useLayoutEffect(() => {
    currentThread.current = parentKey;
    return () => {
      currentThread.current = null;
    };
  }, [parentKey]);

  return (text: string, hasAttachments: boolean, clearDraft: () => void): false | Promise<void> => {
    const command = parseSideChatSlashCommand(text);
    if (!command) return false;
    return (async () => {
      if (busy.current) return;
      if (!parent.session || (provider !== "codex" && provider !== "claudeAgent")) {
        Alert.alert("Start a Codex or Claude conversation before creating a side chat.");
        return;
      }
      if (hasAttachments) {
        Alert.alert("Open the side chat first, then attach files or context there.");
        return;
      }
      busy.current = true;
      try {
        const threadId = ThreadId.make(uuidv4());
        const createdAt = new Date().toISOString();
        const created = await create({
          environmentId,
          input: {
            threadId,
            projectId: parent.projectId,
            title: command.prompt.slice(0, 100) || "Side chat",
            modelSelection: parent.modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            forkedFromThreadId: parent.id,
            createdAt,
          },
        });
        if (created._tag === "Failure") {
          if (!isAtomCommandInterrupted(created))
            Alert.alert("Could not create side chat", String(squashAtomCommandFailure(created)));
          return;
        }
        const key = scopedThreadKey(environmentId, threadId);
        setComposerDraftText(key, command.prompt);
        if (currentThread.current === parentKey) clearDraft();
        if (command.prompt) {
          const sent = await start({
            environmentId,
            input: {
              threadId,
              message: {
                messageId: MessageId.make(uuidv4()),
                role: "user",
                text: command.prompt,
                attachments: [],
              },
              modelSelection: parent.modelSelection,
              runtimeMode: parent.runtimeMode,
              interactionMode: parent.interactionMode,
              createdAt,
            },
          });
          if (sent._tag === "Success") {
            if (getComposerDraftSnapshot(key).text === command.prompt)
              setComposerDraftText(key, "");
          } else if (!isAtomCommandInterrupted(sent)) {
            Alert.alert(
              "Side chat message saved as a draft",
              String(squashAtomCommandFailure(sent)),
            );
          }
        }
        if (currentThread.current === parentKey)
          navigation.navigate("Thread", { environmentId, threadId });
      } finally {
        busy.current = false;
      }
    })();
  };
}
