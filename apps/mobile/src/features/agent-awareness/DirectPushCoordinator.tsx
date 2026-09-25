import { useEffect } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentThreadShells } from "../../state/threads";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { usesDirectApplePush } from "./capabilities";
import {
  observeDirectPushToken,
  refreshDirectPushRegistration,
  setDirectPushConnections,
} from "./directRegistration";

const phaseAtom = Atom.make((get) =>
  JSON.stringify(
    get(environmentThreadShells.threadShellsAtom).map((thread) => [
      thread.id,
      thread.latestTurn?.turnId,
      thread.latestTurn?.state,
      thread.session?.status,
      thread.hasPendingApprovals,
      thread.hasPendingUserInput,
    ]),
  ),
);

function EnabledCoordinator() {
  const { savedConnectionsById, isLoadingSavedConnection } = useSavedRemoteConnections();
  const phases = useAtomValue(phaseAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  useEffect(() => {
    if (!isLoadingSavedConnection)
      void setDirectPushConnections(Object.values(savedConnectionsById));
  }, [savedConnectionsById, isLoadingSavedConnection]);
  useEffect(() => {
    if (AppState.currentState === "active") void refreshDirectPushRegistration();
    // Both values are refresh signals; the registration reads persisted preferences and server state.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [phases, preferences]);
  useEffect(() => {
    const state = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshDirectPushRegistration();
    });
    const tokens = Notifications.addPushTokenListener(observeDirectPushToken);
    return () => {
      state.remove();
      tokens.remove();
    };
  }, []);
  return null;
}

export function DirectPushCoordinator() {
  return usesDirectApplePush() ? <EnabledCoordinator /> : null;
}
