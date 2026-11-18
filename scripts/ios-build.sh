#!/usr/bin/env bash
# Builds the Domus iOS app on a Mac (GitHub Actions or locally):
#   1. generates the Xcode project (tauri ios init) and the app icon
#   2. adds the permission texts and background audio to Info.plist
#   3. builds an unsigned .ipa for iPhones/iPads (arm64)
#   4. optionally (SIMULATOR=1) builds for the iOS simulator, starts it with a
#      seeded test server and takes screenshots
#
# Output in dist-ios/: Domus_<version>_unsigned.ipa, simulator screenshots, logs.
# An unsigned .ipa must be signed before it runs on a device – e.g. with
# AltStore or Sideloadly and your own Apple ID (see docs/INSTALL.md).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-ios"
mkdir -p "$OUT"
cd "$ROOT/app"
VERSION=$(node -p "require('./package.json').version")

step() { echo; echo "=== $*"; }

step "Xcode project"
rm -rf src-tauri/gen/apple
npx tauri ios init --ci || exit 1
npx tauri icon src-tauri/icons/ios-source.png -o "$ROOT/target/ios-icons" >/dev/null
# Only the iOS part of the generated icons goes into the Xcode project.
ASSETS=$(find src-tauri/gen/apple -name "AppIcon.appiconset" -type d | head -1)
if [ -n "$ASSETS" ] && [ -d "$ROOT/target/ios-icons/ios" ]; then
  cp "$ROOT"/target/ios-icons/ios/*.png "$ASSETS"/
fi

step "Info.plist"
PLIST=$(find src-tauri/gen/apple -name Info.plist -path "*_iOS*" | head -1)
echo "plist: $PLIST"
PB=/usr/libexec/PlistBuddy
set_key() { $PB -c "Delete :$1" "$PLIST" >/dev/null 2>&1; $PB -c "Add :$1 $2 $3" "$PLIST"; }
set_key CFBundleDisplayName string "Domus"
set_key NSMicrophoneUsageDescription string "Domus braucht das Mikrofon für Sprach- und Videoanrufe und Sprachnachrichten."
set_key NSCameraUsageDescription string "Domus braucht die Kamera für Videoanrufe und zum Scannen von QR-Codes."
set_key NSLocalNetworkUsageDescription string "Domus verbindet sich mit Servern in deinem Netzwerk."
set_key NSPhotoLibraryAddUsageDescription string "Domus speichert Bilder, Clips und Dateien auf Wunsch in deiner Mediathek."
set_key ITSAppUsesNonExemptEncryption bool false
$PB -c "Delete :UIBackgroundModes" "$PLIST" >/dev/null 2>&1
$PB -c "Add :UIBackgroundModes array" -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
$PB -c "Print" "$PLIST" | head -60

if [ "${DEVICE:-1}" = "1" ]; then
step "Device build (unsigned .ipa)"
npx tauri ios build --target aarch64 --no-sign --ci 2>&1 | tee "$OUT/build-device.log"
IPA=$(find src-tauri/gen/apple/build -name "*.ipa" | head -1)
if [ -z "$IPA" ]; then echo "no .ipa produced"; exit 1; fi
cp "$IPA" "$OUT/Domus_${VERSION}_unsigned.ipa"
(cd "$OUT" && unzip -l "Domus_${VERSION}_unsigned.ipa" | tail -3; unzip -p "Domus_${VERSION}_unsigned.ipa" "Payload/*.app/Info.plist" > Info-device.plist && plutil -p Info-device.plist | head -40)
fi

if [ "${SIMULATOR:-0}" != "1" ]; then exit 0; fi

step "Test server"
cd "$ROOT"
cargo build -p nexus-server >/dev/null 2>&1
node tests/e2e/seed.mjs 7979 > "$OUT/seed.log" 2>&1 &
for i in $(seq 1 90); do grep -q READY "$OUT/seed.log" && break; sleep 1; done
TOKEN=$(awk '/^READY/{print $3}' "$OUT/seed.log")
[ -n "$TOKEN" ] || { echo "test server did not start"; cat "$OUT/seed.log"; exit 3; }

step "Simulator"
LINE=$(xcrun simctl list devices available | grep -E "^ +iPhone 1[5-9]( Pro)? \(" | head -1)
DEV=$(echo "$LINE" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
NAME=$(echo "$LINE" | sed -E 's/^ +(.*) \([0-9A-F-]{36}\).*/\1/')
echo "device: $NAME ($DEV)"
xcrun simctl boot "$DEV" || true
xcrun simctl bootstatus "$DEV" -b
xcrun simctl status_bar "$DEV" override --time "9:41" --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 || true

# `tauri ios dev` builds the debug app for the simulator (the Rust build
# phase needs the Tauri CLI running). Its own install step then tries to
# archive and fails without a development team – the built .app is used directly.
cd "$ROOT/app"
npx tauri ios dev "$NAME" --no-watch > "$OUT/build-sim.log" 2>&1 || true
APP=$(ls -d "$HOME"/Library/Developer/Xcode/DerivedData/*/Build/Products/debug-iphonesimulator/*.app 2>/dev/null | head -1)
echo "simulator app: ${APP:-none}"
[ -n "$APP" ] || { tail -60 "$OUT/build-sim.log"; exit 4; }
lipo -info "$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")" || true
# The debug app loads its UI from the Vite dev server.
npm run dev -- --port 5173 --strictPort > "$OUT/vite.log" 2>&1 &
VITEPID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5173 && break; sleep 1; done
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")
xcrun simctl install "$DEV" "$APP"
xcrun simctl launch "$DEV" "$BUNDLE"
sleep 30
xcrun simctl io "$DEV" screenshot "$OUT/ios-1-welcome.png"
DATA=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data)
echo "data container: $DATA"
find "$DATA" -maxdepth 6 \( -name logs -o -name client.json -o -name "*.log" \) | tee "$OUT/paths.txt"
LOGDIR=$(find "$DATA" -maxdepth 6 -type d -name logs | head -1)
APPDIR=${LOGDIR:+$(dirname "$LOGDIR")}
APPDIR=${APPDIR:-"$DATA/Library/Application Support/$BUNDLE"}
mkdir -p "$APPDIR"
xcrun simctl terminate "$DEV" "$BUNDLE" || true
cat > "$APPDIR/client.json" <<JSON
{"servers":[{"id":"ci","address":"http://127.0.0.1:7979","fingerprint":null,"name":"Cyber Crew","username":"christian","token":"$TOKEN"}],
 "settings":{"theme":"cyber","uiSounds":false,"notifications":false},"host_autostart":false,"hosts_autostart":false,"minimize_to_tray":true}
JSON
xcrun simctl launch "$DEV" "$BUNDLE"
sleep 30
xcrun simctl io "$DEV" screenshot "$OUT/ios-2-channels.png"
cp "$APPDIR/client.json" "$OUT/client-after.json" 2>/dev/null
find "$APPDIR/logs" -type f -exec tail -60 {} \; > "$OUT/app.log" 2>/dev/null
kill $VITEPID 2>/dev/null
echo "done"
