#!/usr/bin/env bash
# Build tools/tickrate (JDK 17 container, Gradle cache in the volume forgeaip-gradle) when the jar is missing or older than
# its sources. Prints the jar's path.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
jar=$dir/build/libs/forgeaip-tickrate-1.0.0.jar
JDK=eclipse-temurin@sha256:91011320978c10ec51d2cde1eb6f616db6d2a739a0e521096c343dd3fed9abe6
if [ ! -f "$jar" ] || [ -n "$(find "$dir/src" "$dir/build.gradle" -newer "$jar" 2>/dev/null)" ]; then
  docker run --rm --memory 3g -u 0 -v forgeaip-gradle:/root/.gradle -v "$dir":/src -w /src "$JDK" ./gradlew --no-daemon -q build >&2
  docker run --rm -u 0 -v "$dir":/src alpine:3.20 chown -R "$(id -u):$(id -g)" /src/build /src/.gradle >/dev/null 2>&1 || true
fi
echo "$jar"
