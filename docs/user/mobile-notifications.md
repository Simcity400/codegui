# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

While the iPhone app is open, alerts appear as banners for every thread except the one on screen; the Android app keeps ordinary alerts quiet in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Standard builds require T3 Connect for background delivery; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

The personal iPhone build receives notifications directly from your T3 server, using its own Apple push credentials. It works over direct, Tailscale, and T3 Connect connections after registering with the server. Keep the server running while agents work. Open the app while work is active to start a Live Activity; it then updates through Apple while the app is in the background, including follow-up turns started while it still shows Done. Each environment has its own card. **Settings → Notifications** reports registration or Apple delivery errors and lets you reconnect.

For other custom iPhone builds, the sending service must have Apple push credentials authorized for the build's app identifier and signing team. Signing in to the official T3 Connect service does not configure those credentials.
