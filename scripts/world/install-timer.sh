#!/usr/bin/env bash
# Install the hourly snapshot timer as a systemd user unit of coder (lingering is on, so it runs without a login).
source "$(dirname "$0")/lib.sh"
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO"/scripts/world/systemd/forgeaip-world-snapshot.{service,timer} "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now forgeaip-world-snapshot.timer
systemctl --user list-timers forgeaip-world-snapshot.timer --no-pager
