#!/usr/bin/env bash
# Builds the signed Domus APK (ARM64 + x86_64) on Windows without developer mode.
#
# `tauri android build` compiles the Rust library for each target but then wants
# to put it into the Android project with a symbolic link, which Windows only
# allows in developer mode. So each target is compiled by the Tauri CLI (the
# symlink error at the end is expected) and Gradle copies the libraries
# (-PdomusPrebuilt=true, see gen/android/buildSrc/.../BuildTask.kt).
#
# Needs JAVA_HOME, ANDROID_HOME and NDK_HOME (see docs/INSTALL.md).
# Output: app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
set -u
cd "$(dirname "$0")/../app"
for t in aarch64 x86_64; do
  echo "== Rust library for $t"
  npx tauri android build --apk --target "$t" >"../target/android-$t.log" 2>&1
  case $t in aarch64) triple=aarch64-linux-android ;; x86_64) triple=x86_64-linux-android ;; esac
  lib="../target/$triple/release/libnexustalk_lib.so"
  if ! grep -q "Finished" "../target/android-$t.log" || [ ! -f "$lib" ]; then
    echo "Rust build for $t failed, see target/android-$t.log" >&2
    tail -20 "../target/android-$t.log" >&2
    exit 1
  fi
done
echo "== Gradle"
cd src-tauri/gen/android
./gradlew assembleUniversalRelease -PdomusPrebuilt=true -PabiList=arm64-v8a,x86_64 -ParchList=arm64,x86_64 -PtargetList=aarch64,x86_64
