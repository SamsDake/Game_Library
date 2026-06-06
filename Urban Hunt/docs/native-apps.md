# Native Android/iOS Builds

Urban Hunt now has Capacitor native projects in `android/` and `ios/`.

## Backend URL

Native apps do not share origin with the Express server. Before building a native app, set the client backend URL:

```powershell
$env:VITE_API_BASE_URL="https://your-urban-hunt-server.example.com"
npm run native:sync
```

For local device testing, use a URL the phone can reach, not `127.0.0.1` from the development machine.

## Background Location

The native app uses `@capacitor-community/background-geolocation` when running on iOS or Android. The browser/PWA build still uses foreground web geolocation.

Android permissions are declared in `android/app/src/main/AndroidManifest.xml`.
iOS permissions and background location mode are declared in `ios/App/App/Info.plist`.

## Commands

```powershell
npm run native:sync
npm run native:android
npm run native:ios
```

`native:android` opens Android Studio. `native:ios` requires macOS with Xcode.

## Build Requirements

Android builds require a JDK and Android Studio/SDK. This workspace did not have `JAVA_HOME` or `java` configured, so `gradlew assembleDebug` could not be completed here.

iOS builds require macOS, Xcode, signing capabilities, and a physical-device test for background location.
