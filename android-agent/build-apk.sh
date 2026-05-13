#!/usr/bin/env bash
# build-apk.sh — builds the CyberSentinel MDM agent APK inside a slim
# containerised Android SDK + JDK 17. The host only needs Docker.
#
# Usage:
#   ./build-apk.sh           # debug APK (default)
#   ./build-apk.sh release   # unsigned release APK
#
# First run builds the local builder image (~1.3 GB) and downloads Gradle
# deps (~500 MB) — total ~5 min on a fast link. Subsequent runs reuse both
# caches and finish in well under a minute.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE_TAG="cybersentinel-android-builder:latest"
VARIANT="${1:-debug}"
TASK="assemble${VARIANT^}"   # assembleDebug / assembleRelease

# Step 1: build the slim builder image if absent (or if the Dockerfile changed).
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "🧱  Building local Android builder image ($IMAGE_TAG)…"
    docker build -t "$IMAGE_TAG" ./builder
fi

# Step 2: persistent Gradle cache so dependency downloads happen once.
docker volume create mdm-gradle-cache >/dev/null 2>&1 || true

echo "🛠  Building CyberSentinel MDM agent ($VARIANT)…"
docker run --rm \
  -v "$PWD:/project" \
  -v mdm-gradle-cache:/root/.gradle \
  -w /project \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e JAVA_TOOL_OPTIONS=-Xmx3g \
  "$IMAGE_TAG" \
  bash -lc "
    set -e
    if [ ! -x ./gradlew ]; then
      echo '→ generating gradle wrapper (gradle 8.7)'
      gradle wrapper --gradle-version 8.7 --distribution-type bin 2>/dev/null || {
        echo '→ no system gradle; bootstrapping wrapper from network'
        curl -sSL https://services.gradle.org/distributions/gradle-8.7-bin.zip -o /tmp/g.zip
        unzip -q /tmp/g.zip -d /opt
        /opt/gradle-8.7/bin/gradle wrapper --gradle-version 8.7 --distribution-type bin
        rm /tmp/g.zip
      }
    fi
    ./gradlew :app:$TASK --no-daemon --console=plain --stacktrace
  "

APK="app/build/outputs/apk/${VARIANT}/app-${VARIANT}.apk"
if [ -f "$APK" ]; then
  echo
  echo "✅ APK ready: $(realpath "$APK")"
  ls -lh "$APK"
  echo
  echo "Install on a connected phone with:"
  echo "  adb install -r '$APK'"
  echo "Set Device Owner (must be the only user; factory-reset first if needed):"
  echo "  adb shell dpm set-device-owner com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver"
else
  echo "❌ APK not produced; check the build log above"
  exit 1
fi
