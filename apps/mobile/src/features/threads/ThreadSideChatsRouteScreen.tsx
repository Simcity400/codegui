import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { attachedSideChatsOf } from "@t3tools/client-runtime/state/sideChat";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";
import { Alert, FlatList, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadStatus } from "./threadPresentation";

/**
 * The side chats attached to one thread. Reached from the thread header only
 * when two or more exist (a single side chat opens directly). Rows swipe to
 * promote or delete, matching the home list's row actions.
 */
export function ThreadSideChatsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const theme = useUniwindTheme();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const parent = useThreadShell({ environmentId, threadId });
  const threads = useThreadShells();
  const chats = useMemo(
    () => (parent ? attachedSideChatsOf(parent, threads) : []),
    [parent, threads],
  );
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);

  // Once every side chat is promoted or deleted there is nothing to list, so
  // the screen leaves as soon as it is (or becomes) the focused one.
  const hadChats = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (chats.length > 0) hadChats.current = true;
      else if (hadChats.current) navigation.goBack();
    }, [chats.length, navigation]),
  );

  const openChat = useCallback(
    (chat: EnvironmentThreadShell) =>
      navigation.dispatch(
        StackActions.push("Thread", {
          environmentId: String(chat.environmentId),
          threadId: String(chat.id),
        }),
      ),
    [navigation],
  );
  const promoteChat = useCallback(
    async (chat: EnvironmentThreadShell) => {
      const result = await updateThreadMetadata({
        environmentId: chat.environmentId,
        input: { threadId: chat.id, sideChatPromotedAt: new Date().toISOString() },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not promote side chat",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [updateThreadMetadata],
  );
  const deleteChat = useCallback(
    (chat: EnvironmentThreadShell) =>
      Alert.alert("Delete side chat?", "This permanently deletes its messages.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void deleteThread({
              environmentId: chat.environmentId,
              input: { threadId: chat.id },
            }).then((result) => {
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                Alert.alert(
                  "Could not delete side chat",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }),
        },
      ]),
    [deleteThread],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) openSwipeableRef.current = null;
  }, []);

  if (!parent) {
    return <EmptyState title="Thread unavailable" detail="Return to your threads and try again." />;
  }

  return (
    <FlatList
      className="flex-1 bg-screen"
      data={chats}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingVertical: 8, paddingBottom: insets.bottom + 16 }}
      onScrollBeginDrag={() => openSwipeableRef.current?.close()}
      ListHeaderComponent={
        <Text className="px-5 pb-2 text-sm text-foreground-muted" numberOfLines={2}>
          Side chats of {parent.title}. Swipe a row to promote or delete it.
        </Text>
      }
      renderItem={({ item }) => {
        const status = resolveThreadStatus(item);
        return (
          <ThreadSwipeable
            threadKey={`${item.environmentId}:${item.id}`}
            backgroundColor={theme["--color-screen"]}
            fullSwipeWidth={windowWidth - 32}
            onDelete={() => deleteChat(item)}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            primaryAction={{
              accessibilityLabel: `Promote ${item.title} to a thread`,
              icon: "arrow.up.right.square",
              label: "Promote",
              onPress: () => void promoteChat(item),
            }}
            resetKey={`${item.environmentId}:${item.id}`}
            threadTitle={item.title}
          >
            {() => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open side chat: ${item.title}`}
                onPress={() => openChat(item)}
                className="flex-row items-center gap-3 px-5 py-3 active:opacity-70"
              >
                <SymbolView
                  name="bubble.left.and.bubble.right"
                  size={20}
                  tintColorClassName="accent-icon"
                />
                <View className="min-w-0 flex-1">
                  <Text className="text-base text-foreground" numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text className="mt-0.5 text-sm text-foreground-muted" numberOfLines={1}>
                    {[status?.label, relativeTime(item.updatedAt ?? item.createdAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-icon-subtle"
                />
              </Pressable>
            )}
          </ThreadSwipeable>
        );
      }}
      ListEmptyComponent={
        <EmptyState
          title="No side chats"
          detail="Use /side in the conversation to start a side chat with Codex or Claude."
        />
      }
    />
  );
}
