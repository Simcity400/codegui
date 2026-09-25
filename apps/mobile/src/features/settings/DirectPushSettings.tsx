import { useCallback, useSyncExternalStore } from "react";
import { Alert, Linking } from "react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { AppText } from "../../components/AppText";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  getDirectPushStatus,
  refreshDirectPushRegistration,
  subscribeDirectPushStatus,
} from "../agent-awareness/directRegistration";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

export function DirectPushSettings() {
  const status = useSyncExternalStore(
    subscribeDirectPushStatus,
    getDirectPushStatus,
    getDirectPushStatus,
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const liveEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.liveActivitiesEnabled !== false;
  const enableNotifications = useCallback(() => {
    void runtime
      .runPromise(requestAgentNotificationPermission)
      .then(async (result) => {
        if (result.type === "granted") await refreshDirectPushRegistration();
        else
          Alert.alert(
            "Enable notifications",
            "Allow notifications for T3 Code in iPhone Settings.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Open Settings",
                onPress: () => {
                  void Linking.openSettings();
                },
              },
            ],
          );
      })
      .catch(() =>
        Alert.alert("Notifications unavailable", "Could not request notification permission."),
      );
  }, []);
  return (
    <SettingsScreen title="Notifications">
      <ScreenScrollView contentContainerClassName="gap-6 px-5 py-4">
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            subtitle="Receive agent alerts from your connected server"
            value={status.ready && status.notificationsEnabled}
            onValueChange={(enabled) => {
              if (enabled) enableNotifications();
              else void Linking.openSettings();
            }}
          />
          <SettingsSwitchRow
            icon="bolt.circle"
            label="Live Activity Updates"
            subtitle="Follow agent work on your Lock Screen"
            value={liveEnabled && status.ready}
            disabled={!AsyncResult.isSuccess(preferences)}
            onValueChange={(enabled) => save({ liveActivitiesEnabled: enabled })}
          />
          <SettingsRow
            icon="arrow.clockwise"
            label="Reconnect notifications"
            onPress={() => {
              void refreshDirectPushRegistration();
            }}
          />
        </SettingsSection>
        <AppText className="text-sm text-foreground-muted">
          {status.error ??
            "Your server is ready to send notifications. Keep it running while agents work. Open the app while work is active to start its Live Activity."}
        </AppText>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
