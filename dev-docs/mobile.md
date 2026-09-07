# Mobile build guide (Capacitor - iOS & Android)

How to build and run the aloud mobile app. The shell is **Capacitor** (not
Tauri mobile - decision in bead `meditation-pal-zp47` / `-nn1`): it wraps the
same `ts/ui` web app in the OS system WebView (WKWebView / Android System
WebView) and adds native plugins for the things a browser can't do. Desktop
stays on Tauri; only the mobile shell + a few platform adapters differ.

Signing + store release (TestFlight / Play internal testing) is a separate
walkthrough: [mobile-signing.md](mobile-signing.md).

`ts/ios/` and `ts/android/` are **committed** - they carry hand-edited native
config (permission strings, URL schemes, capabilities, icons) that `cap add`
would wipe. A fresh clone builds without regenerating them. The "required native
config" section below is the record of those edits, for reference or a rebuild.

## What runs where

- **UI**: `ts/ui` built to `ts/ui/dist` (`webDir` in `capacitor.config.ts`),
  loaded from `capacitor://localhost` (iOS) / `https://localhost` (Android).
- **App mode**: a production Capacitor build resolves to **web mode**
  automatically (`app-mode.ts` → not Tauri, not `import.meta.env.DEV` → `web`).
  So Ollama / claude-proxy are hidden and **aloud cloud** is the default
  provider, exactly like the hosted website.
- **Backends**: there is no on-device backend. `/app/v1` (catalogs, system-info)
  and `/cloud/v1` (auth, credits, metered LLM/STT/TTS) both resolve **off-origin
  to aloud cloud**, via `VITE_ALOUD_CLOUD_URL` baked into the build. You MUST
  build with that set (see below) or the app has no backend.

### Native adapters (swap on `isCapacitor()`)

Everything mobile-specific is gated on `isCapacitor()` (`ui/src/is-desktop.ts`)
and is a no-op on web/desktop, so these changes never touch the other builds:

| Concern | Native (Capacitor) | Web / desktop | File |
|---|---|---|---|
| Storage | `CapacitorKv` (@capacitor/preferences - durable UserDefaults / SharedPreferences) | `LocalStorageKv` | `adapters/kv.ts`, `adapters/capacitor-kv.ts` |
| STT | `CapacitorSttEngine` (SFSpeechRecognizer / Android SpeechRecognizer) | web-speech / server-whisper / aloud cloud | `adapters/stt-picker.ts`, `adapters/capacitor-stt.ts` |
| Keep-awake | `@capacitor-community/keep-awake` | web Wake Lock API | `wakelock.ts` |
| External links / Stripe | `@capacitor/browser` (in-app SFSafariViewController / Custom Tab) | Tauri opener / full-page redirect | `external-links.ts` |
| Sign-in | native Google/Apple via `@capgo/capacitor-social-login` (+ email) | web GIS / Apple JS, or desktop loopback PKCE | `sign-in-modal.ts`, `native-signin.ts` |

#### The speech plugin is patched - don't lose the patch

`@capacitor-community/speech-recognition` is patched in `ts/patches/`, applied by
`postinstall` via patch-package (the Android build compiles plugin source
straight from `node_modules`, so the patch is load-bearing at build time).
Stock v7 leaves `onReadyForSpeech` empty and, in partial-results mode, rejects an
already-resolved call on `onError` - so JS saw neither "recognizer is live" nor
any error (NO_MATCH, SPEECH_TIMEOUT, BUSY). The patch emits `listeningState:
'ready'` and `listeningState: 'error'` (with the numeric `errorCode`, since
stock maps the API 31+ codes such as SERVER_DISCONNECTED to "Didn't
understand", which reads as silence); `CapacitorSttEngine` keys its startup
watchdog and silence handling on them. Note the stock `'started'` event is
`onBeginningOfSpeech` - user speech, not launch.

The Android session model (`meditation-pal-lbl5`, 2026-09-06) is the bigger
patch. Stock destroyed and recreated the `SpeechRecognizer` on every `start()`
(a fresh service bind per segment, 1-3s deaf, ERROR_CLIENT when the bind raced
the old teardown). Patched: one recognizer for the life of the plugin, created
with `createOnDeviceSpeechRecognizer` where available; nothing in the loop
cancels or destroys it, and a `start()` that lands on a live session is queued
until that session closes. The close is reported as a `partialResults` event
with `final: true` (usually with no matches - in dictation mode the last partial
was the transcript), so the adapter folds the segment and relaunches in ~50ms.
The `silenceLengthMs` start option sets Android's
`EXTRA_SPEECH_INPUT_*_SILENCE_LENGTH_MILLIS` extras; on the OnePlus 13 that
governs the no-speech timeout (and roughly the session length), not the
in-utterance endpointer, so the adapter sends a long
`NATIVE_ENDPOINT_SILENCE_MS` and its own end-of-turn timer owns the turn. The
recognition service also plays an earcon on the notification stream at every
session start and end (heard by its own endpointer - a restart loop with a
beep every few seconds); the plugin mutes that stream while a session is open.
To change the patch: edit under `node_modules`, then
`npx patch-package @capacitor-community/speech-recognition --exclude 'android/build'`
(the exclude keeps gradle's build artifacts out of the diff).

Because postinstall runs it, `patch-package` is a **regular dependency**, not a
dev one: the server image installs with `--omit=dev` and died on a missing
binary until that moved (`ce07963`).

## Prerequisites

- **Node** (repo's version) + the deps: `cd ts && npm install`.
- **iOS**: macOS, Xcode, and **CocoaPods** (`sudo gem install cocoapods` or
  `brew install cocoapods`). An Apple Developer account for signing / TestFlight.
- **Android**: Android Studio (or the SDK command-line tools) and a **JDK 21** - Capacitor 8's Gradle modules target Java 21, so JDK 17 fails with
  `invalid source release: 21`. Android Studio's bundled JBR is JDK 21; point
  Gradle at it (`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`)
  or `brew install --cask temurin@21`. Set `ANDROID_HOME` (default
  `~/Library/Android/sdk`). A Play Console account for internal testing.
- **Decline Android Studio's upgrade prompts** (AGP / Gradle "Upgrade
  Assistant"): Capacitor generates the project against a pinned AGP major,
  and its plugins under `node_modules` build against it too - accepting the
  bump (e.g. AGP 9) breaks the build immediately. Those upgrades arrive via
  Capacitor releases (`npx cap migrate`). If accepted by accident, revert
  `android/build.gradle`, `android/gradle.properties`, and
  `android/gradle/wrapper/gradle-wrapper.properties`.

## First build

The `cap:*` npm scripts build the UI and sync in one step, and refuse to run
without `VITE_ALOUD_CLOUD_URL` (a build without it has no backend):

```bash
cd ts
export VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev
npm run cap:android:run  # ui:build + cap sync android + Gradle build +
                         # install/launch on the connected device (adb).
                         # No Android Studio needed - the main way to run.
npm run cap:sync       # ui:build + cap sync (both platforms)
npm run cap:ios        # ui:build + cap sync ios + open Xcode
npm run cap:android    # ui:build + cap sync android + open Android Studio
```

`cap:android:run` auto-picks the only connected device/emulator; with several,
it prompts (or pass `-- --target <adb-serial>`). It installs the debug APK -
release/Play builds still go through the signed `.aab` path
([mobile-signing.md](mobile-signing.md)). Android
Studio is only needed for native debugging; the webview console is available
directly with `adb logcat -s Capacitor/Console Capacitor`.

After any UI change re-run `cap:android:run` (or `cap:sync`; `npx cap copy`
suffices for web-asset-only changes). Rebuilding from inside Android Studio
does NOT rebuild `ui/dist` - it repackages the last-synced bundle. For fast
iteration use live-reload: uncomment the `server` block in
`capacitor.config.ts` (point `url` at your LAN Vite dev server) or run
`npx cap run ios --livereload --external`.

> If you ever *do* regenerate iOS, it MUST use CocoaPods, not the Capacitor-8
> default (SPM): `@capacitor-community/speech-recognition@7.0.1` has no
> `Package.swift`, so an SPM build silently drops it and native STT breaks.
> `npx cap add ios --packagemanager CocoaPods`.

## Required native config (the committed native edits)

### iOS - `ios/App/App/Info.plist`

The mic + speech-recognition permission strings. Without these iOS **crashes**
the moment the plugin asks for the mic, rather than showing a prompt:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>aloud listens while you speak so it can respond in your practice.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>aloud transcribes your speech to understand what you share.</string>
```

(These are visible user-facing copy - keep them honest and warm, and mind the
brand copy rules: no em-dashes, no "AI" tells.)

### Android - `android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

`INTERNET` is present by default; `RECORD_AUDIO` must be added. The
speech-recognition plugin requests it at runtime (first mic use).
`MODIFY_AUDIO_SETTINGS` is required for the cloud/Whisper STT path: Capacitor's
WebChromeClient grants a WebView `getUserMedia` audio request only if EVERY
permission it asks for is granted, and for `AUDIO_CAPTURE` it requests both
`RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. Undeclared, the latter returns denied
and the whole mic grant fails with `NotAllowedError` (bead `t25n`).

### Native sign-in (Google + Apple)

The app-side is wired (`native-signin.ts`, via `@capgo/capacitor-social-login`);
each provider hands an ID token to the existing `googleSignIn`/`appleSignIn`
server calls. To turn it on you need the OAuth consoles + build-time client ids
(bead `tpj4`) - the console-by-console walkthrough is in
[mobile-signin-setup.md](mobile-signin-setup.md). App Store Guideline 4.8: if iOS offers Google it must offer Apple
too - configure both for the store build.

**Build-time env** (bake like `VITE_ALOUD_CLOUD_URL`):

```
VITE_GOOGLE_CLIENT_ID=<web client id>        # reused as the plugin webClientId
VITE_GOOGLE_IOS_CLIENT_ID=<iOS client id>    # Google Cloud → iOS OAuth client
VITE_APPLE_CLIENT_ID=<apple services id>     # Sign in with Apple Services ID
# VITE_APPLE_REDIRECT_URL=<url>              # only for Apple-on-Android (iOS ignores)
```

**Google Cloud console:** create an **iOS OAuth client** for bundle
`app.aloud.meditation`; keep the existing **web** client. Add **both** client ids
to the server's `GOOGLE_CLIENT_IDS` (accepted token audiences) - the native
iOS token's `aud` is the iOS client id, the Android/web token's is the web one.

**iOS Info.plist** - add the Google **reversed-client-id** URL scheme (Google
Cloud shows it for the iOS client; it looks like `com.googleusercontent.apps.NNN`):

```xml
<key>CFBundleURLTypes</key>
<array><dict><key>CFBundleURLSchemes</key>
  <array><string>com.googleusercontent.apps.YOUR-IOS-CLIENT-ID</string></array>
</dict></array>
```

**Apple Developer:** enable the **Sign in with Apple** capability + entitlement
on the app id (add the capability in Xcode too); create/confirm a **Services ID**
(→ `VITE_APPLE_CLIENT_ID`); ensure the server's Apple verification accepts the
app **bundle id** as the token audience for the native iOS flow.

### App icons

iOS **rejects icons with an alpha channel**, so the transparent orb
(`ts/ui/public/aloud.png`) can't be used directly. A flattened, alpha-stripped
source is ready at `assets/aloud-orb-icon-opaque-1024.png` (orb on white, RGB,
1024²). Use it for the iOS icon set; Android allows alpha + adaptive icons, so
the transparent orb is fine there. Finalize the iOS background (white vs
warm-gradient vs dark) before store submission. See bead `meditation-pal-3k5`.

## Payments (beta)

Zero IAP code for the beta. Credits are bought on **aloud.rest via Stripe** and
are account-bound, so they appear in the app after purchase via the existing
ledger/auth. The buy-credits modal opens Stripe in `@capacitor/browser` and
polls `/me` for the balance to land (Stripe can't redirect back into the
`capacitor://` origin, so there's no return URL - same waiting flow as desktop).
USDC/x402 is hidden on mobile (App Store 3.1.1 forbids crypto unlocks; the modal
already hides it when `window.ethereum` is absent). Native StoreKit / Play
Billing consumable packs are deferred to public launch - see `zp47`, `czr`,
`a2j`.

## Still device-dependent (not done, needs real hardware)

The TS layer is complete and tested, but these can only be validated on a
device/simulator and are tracked separately:

- **iOS audio session** - `playAndRecord` + concurrent mic during TTS playback
  (barge-in), 30-min playback with the screen off, survives backgrounding. This
  is the crux from `meditation-pal-nn1`. WKWebView's `getUserMedia` should work
  once `NSMicrophoneUsageDescription` is set, but the session category behavior
  under TTS playback is the open risk.
- **Native STT/TTS quality per device** - which device/OS categories the free
  on-device recognizer + voices are good enough to default to, vs falling back
  to cloud. Full manual-validation matrix (buckets, test cases, default-by-
  category-and-cost logic) in
  [mobile-device-validation.md](mobile-device-validation.md). Beads `0ao`
  (STT), `g0ox` (TTS). If native cuts off, the cloud fallbacks
  (`aloud-gpt-transcribe` STT - the choice labelled "aloud cloud" - / cloud
  voices) already work on mobile.
- **Keep-awake** actually holding the screen on across a full session.
- **Native Google/Apple sign-in** - app-side is wired (`native-signin.ts`);
  needs the Google/Apple console setup + build-time client ids above, then a
  device to verify. `meditation-pal-tpj4`.

## Related beads

`zp47` (beta plan) · `3k5` (wrapper) · `7rh` (store submission) · `nn1` (shell
decision) · `0ao` (STT validation) · `dbd` (LLM tiers) · `7ej` (capability
comms) · `czr` (cross-platform credits) · `tpj4` (native sign-in).
