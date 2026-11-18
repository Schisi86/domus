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

step "Device build (unsigned .ipa)"
npx tauri ios build --target aarch64 --no-sign --ci 2>&1 | tee "$OUT/build-device.log"
IPA=$(find src-tauri/gen/apple/build -name "*.ipa" | head -1)
if [ -z "$IPA" ]; then echo "no .ipa produced"; exit 1; fi
cp "$IPA" "$OUT/Domus_${VERSION}_unsigned.ipa"
(cd "$OUT" && unzip -l "Domus_${VERSION}_unsigned.ipa" | tail -3; unzip -p "Domus_${VERSION}_unsigned.ipa" "Payload/*.app/Info.plist" > Info-device.plist && plutil -p Info-device.plist | head -40)

if [ "${SIMULATOR:-0}" != "1" ]; then exit 0; fi

step "Simulator build"
SIMTARGET=${SIMTARGET:-$( [ "$(uname -m)" = "arm64" ] && echo aarch64-sim || echo x86_64 )}
npx tauri ios build --target "$SIMTARGET" --debug --no-sign --archive-only --ci 2>&1 | tee "$OUT/build-sim.log"
APP=$(find src-tauri/gen/apple/build -name "*.app" -path "*imulator*" -o -name "*.app" -path "*x86_64*" | grep -v "\.dSYM" | head -1)
[ -z "$APP" ] && APP=$(find src-tauri/gen/apple/build -name "*.app" -newer "$OUT/build-sim.log" -o -name "*.app" | grep -v dSYM | grep -iv iphoneos | head -1)
echo "simulator app: ${APP:-none}"
[ -z "$APP" ] && { find src-tauri/gen/apple/build -maxdepth 6 | head -80; exit 2; }

step "Test server"
cd "$ROOT"
cargo build -p nexus-server >/dev/null 2>&1
node tests/e2e/seed.mjs 7979 > "$OUT/seed.log" 2>&1 &
for i in $(seq 1 60); do grep -q READY "$OUT/seed.log" && break; sleep 1; done
TOKEN=$(awk '/^READY/{print $3}' "$OUT/seed.log")
echo "seed: $(head -c 80 "$OUT/seed.log")"

step "Simulator"
DEV=$(xcrun simctl list devices available | grep -E "iPhone 1[5-9] Pro \(|iPhone 1[5-9] \(" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
echo "device: $DEV"
xcrun simctl boot "$DEV" || true
xcrun simctl bootstatus "$DEV" -b
xcrun simctl status_bar "$DEV" override --time "9:41" --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 || true
xcrun simctl install "$DEV" "$APP"
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")
xcrun simctl launch "$DEV" "$BUNDLE"
sleep 25
xcrun simctl io "$DEV" screenshot "$OUT/ios-1-welcome.png"
DATA=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data)
echo "data container: $DATA"
find "$DATA" -maxdepth 5 \( -name "logs" -o -name "client.json" \) | tee "$OUT/paths.txt"
APPDIR=$(dirname "$(find "$DATA" -maxdepth 5 -type d -name logs | head -1)")
xcrun simctl terminate "$DEV" "$BUNDLE"
cat > "$APPDIR/client.json" <<JSON
{"servers":[{"id":"ci","address":"http://127.0.0.1:7979","fingerprint":null,"name":"Cyber Crew","username":"christian","token":"$TOKEN"}],
 "settings":{"theme":"cyber","uiSounds":false,"notifications":false},"host_autostart":false,"hosts_autostart":false,"minimize_to_tray":true}
JSON
xcrun simctl launch "$DEV" "$BUNDLE"
sleep 25
xcrun simctl io "$DEV" screenshot "$OUT/ios-2-channels.png"
# Log of the app (Rust side) for the record.
find "$APPDIR/logs" -type f -exec tail -40 {} \; > "$OUT/app.log" 2>/dev/null
grep -c "token_enc" "$APPDIR/client.json" > "$OUT/token-encrypted.txt" 2>/dev/null || true
echo "done"
