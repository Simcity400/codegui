# Personal iPhone push delivery

The `com.simcity400.*` iPhone builds register directly with each connected T3 server. T3 Connect still handles connectivity. The server sends alerts and Live Activity updates to Apple using the personal app's signing credentials.

On the computer running the server, sign in to the matching Expo account with `eas login`, then run:

```sh
node scripts/configure-apple-push.ts
```

This downloads the existing preview app's Apple push key from Expo into `~/.t3/apple-push.json`. For a custom server home, pass `--home-dir <directory>`. Keep this file private and outside the repository. On Windows, restrict its permissions to the account running T3 and SYSTEM. Never put the key into mobile environment variables.

Install the updated personal desktop/server build and restart it, then install the matching iPhone update by tapping the version row five times in Settings → About. Open Settings → Notifications to register. Keep the server running while agents work. Start a turn with the phone app open once to create its Live Activity; subsequent updates arrive through Apple while the app is backgrounded.

The server reads credentials at startup. Registration sends a silent token check to Apple and reports any rejection in the phone's notification settings. `BadDeviceToken` or `DeviceTokenNotForTopic` means the token, bundle identifier, or production/sandbox environment does not match. Invalid credentials leave push delivery disabled while the rest of the server remains available. Each connected environment requires its own push configuration.
