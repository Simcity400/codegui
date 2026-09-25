import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";

import {
  routeAgentNotificationResponseOnce,
  shouldPresentForegroundAgentNotification,
} from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

export function useAgentNotificationNavigation(): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}

let visiblePathname: string | null = null;

/** Presents agent alerts while the app is open, except for the thread on screen. */
export function useForegroundAgentNotifications(pathname: string): void {
  useEffect(() => {
    visiblePathname = pathname;
  }, [pathname]);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const present = shouldPresentForegroundAgentNotification({
          notification,
          visiblePathname,
        });
        return {
          shouldShowBanner: present,
          shouldShowList: present,
          shouldPlaySound: present,
          shouldSetBadge: false,
        };
      },
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);
}
