# Native Push Setup

The Capacitor apps use two notification paths:

- Browser/PWA installs keep using Web Push and VAPID.
- Sideloaded native apps register native tokens. Android tokens are sent through Firebase Cloud Messaging. iOS tokens are sent directly through APNs.

Hide and Seek Companion does not use push notifications and is not part of this setup.

## GitHub Actions Secrets

Android native push requires each APK to include its Firebase `google-services.json`.
Store each JSON file as base64 in these repository secrets:

```text
JETLAG_GOOGLE_SERVICES_JSON_BASE64
```

The current workflow still builds unsigned IPAs. iOS remote push requires an Apple Developer account, a bundle ID with Push Notifications enabled, and an IPA signed with a provisioning profile that contains the `aps-environment` entitlement.

## Server Environment

Set these on the deployed Jetlag server process.

For Android FCM sends, use either:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

or:

```text
FIREBASE_SERVICE_ACCOUNT_BASE64
```

For iOS APNs sends:

```text
APNS_KEY_ID
APNS_TEAM_ID
APNS_PRIVATE_KEY
APNS_BUNDLE_ID
APNS_ENV
```

`APNS_PRIVATE_KEY_BASE64` can be used instead of `APNS_PRIVATE_KEY`. Set `APNS_BUNDLE_ID` to `com.jetlagmobileapp.app`. Set `APNS_ENV` to `development` or `production` to match the provisioning profile used to sign the IPA.
