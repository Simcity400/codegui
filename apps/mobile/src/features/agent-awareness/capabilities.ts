import Constants from "expo-constants";
import { Platform } from "react-native";
import { supportsAndroidAgentNotifications } from "./androidNotifications";

export function usesDirectApplePush() {
  return (
    Platform.OS === "ios" &&
    Constants.expoConfig?.ios?.bundleIdentifier?.startsWith("com.simcity400.") === true
  );
}

export function supportsAgentAwarenessPush() {
  return Platform.OS === "android"
    ? supportsAndroidAgentNotifications()
    : Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}
