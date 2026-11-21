#!/bin/bash
# Run a command with a nested Wayland compositor on the dedicated X11 display in DISPLAY.
set -euo pipefail

if [[ -z "${DISPLAY:-}" ]] || ! command -v weston >/dev/null; then
  echo 'Skipping native Wayland drag tests: Weston and a dedicated X11 display (DISPLAY) are required.'
  exit 0
fi

export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
export WAYLAND_DISPLAY=writing-room-test
weston --backend=x11-backend.so --shell=kiosk-shell.so --use-pixman --no-config \
  --width=1200 --height=780 --socket="$WAYLAND_DISPLAY" --log="$XDG_RUNTIME_DIR/weston.log" &
weston_pid=$!

cleanup() {
  kill "$weston_pid" 2>/dev/null || true
  wait "$weston_pid" 2>/dev/null || true
  rm -f -- "$XDG_RUNTIME_DIR/weston.log" "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.lock"
  rmdir -- "$XDG_RUNTIME_DIR"
}
trap cleanup EXIT

for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]]; then
    E2E_NATIVE_DND=wayland "$@"
    exit
  fi
  if ! kill -0 "$weston_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
echo 'Weston could not start a nested Wayland display.' >&2
if [[ -f "$XDG_RUNTIME_DIR/weston.log" ]]; then
  cat "$XDG_RUNTIME_DIR/weston.log" >&2
fi
exit 1
