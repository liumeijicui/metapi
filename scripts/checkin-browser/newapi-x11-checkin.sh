#!/bin/bash
# Browser-driven check-in for New API sites whose check-in sits behind a
# Cloudflare Turnstile challenge that plain HTTP requests cannot pass.
#
# The site refuses DevTools/CDP-driven sessions, so this drives a real Chromium
# on a virtual X display with synthetic X11 input (xdotool) and reads the
# resulting pixels back (xwd). metapi passes every input through the
# environment and only reads the METAPI_CHECKIN_RESULT line from stdout, so the
# coordinates below are the only site-specific knowledge in here.
#
# Required tools: chromium (or $CHROMIUM_BIN), xdotool, xwd, and either a
# usable $DISPLAY or a local Xvfb. pnmtopng is optional (evidence).
#
# Environment:
#   CHECKIN_SITE_URL      site origin, e.g. https://grok-heavy.878.indevs.in
#   CHECKIN_USERNAME      login name or e-mail
#   CHECKIN_PASSWORD      login password
#   CHECKIN_PROFILE_DIR   Chromium user-data-dir (login session is kept here)
#   CHECKIN_LOG_DIR       screenshots + run.log for this run
#   CHECKIN_PROXY_URL     optional http(s) proxy for the browser
#   CHECKIN_DISPLAY       X display to use when none is alive (default :99)
#   CHROMIUM_BIN          optional chromium executable override
#
# Output contract: the last stdout line is
#   METAPI_CHECKIN_RESULT={"ok":<bool>,"already":<bool>,"detail":"<token>"}
# Exit code 0 only when ok or already is true.
set -u

SITE=${CHECKIN_SITE_URL:?CHECKIN_SITE_URL is required}
USER_NAME=${CHECKIN_USERNAME:?CHECKIN_USERNAME is required}
USER_PASS=${CHECKIN_PASSWORD:?CHECKIN_PASSWORD is required}
PROFILE=${CHECKIN_PROFILE_DIR:?CHECKIN_PROFILE_DIR is required}
LOG=${CHECKIN_LOG_DIR:-/tmp/metapi-checkin-browser}
PROXY=${CHECKIN_PROXY_URL:-}
WANTED_DISPLAY=${CHECKIN_DISPLAY:-:99}
BIN=${CHROMIUM_BIN:-/usr/bin/chromium-browser}

# Pixel coordinates of the elements this flow drives. They belong to the window
# geometry set below (1280x900 at 0,0 on a 1440x1000 display) and must be
# revisited if that geometry ever changes.
#
# Three front-end families are in the wild: the classic dashboard shipped with
# older New API builds, the React one whose sign-in form is centred, and
# motomoto's themed React build. They put the same controls at different
# coordinates and even paint them differently (blue vs amber), so each family
# has its own preset and `classic` stays the default.
apply_layout() {
  LAYOUT="$1"
  # Overlay and badge detection are opt-in: only layouts that define real
  # boxes use them.
  OVERLAY_DIALOG_BOX="0 0 0 0"
  PWD_BUBBLE_BOX="0 0 0 0"
  CHECKIN_BADGE_BOX="0 0 0 0"
  case "$1" in
    moto)
      # The sign-in page carries a GitHub button above the form, so the whole
      # form sits ~42px lower than on the plain rc layout.
      USERNAME_XY="640 484"
      PASSWORD_XY="640 554"
      LOGIN_SHIELD_XY="455 681"
      LOGIN_BUTTON_XY="640 609"
      CHECKIN_BUTTON_XY="1161 454"
      MODAL_SHIELD_XY="509 525"
      CHECKIN_BUTTON_BOX="1115 435 110 32"
      # The claimed-state badge sits on the title row in the Chinese build and
      # on its own row in the English one, so the box covers both spots.
      CHECKIN_BADGE_BOX="960 445 115 55"
      MODAL_TITLE_BOX="490 495 305 60"
      PROFILE_MARKER_BOX="237 185 66 66"
      LOGIN_TICK_BOX="445 665 60 35"
      # Floating panels that must be dismissed before the card is clickable:
      # the site's announcement dialog and Chromium's save-password bubble.
      OVERLAY_DIALOG_BOX="845 590 55 28"
      PWD_BUBBLE_BOX="850 95 300 40"
      ANNOUNCE_CLOSE_XY="905 370"
      PWD_BUBBLE_DISMISS_XY="1019 370"
      EXTRA_LAUNCH_FLAGS="--test-type"
      ;;
    rc)
      USERNAME_XY="640 442"
      PASSWORD_XY="640 512"
      LOGIN_SHIELD_XY="455 641"
      LOGIN_BUTTON_XY="640 567"
      CHECKIN_BUTTON_XY="1192 454"
      MODAL_SHIELD_XY="509 525"
      CHECKIN_BUTTON_BOX="1150 437 90 34"
      MODAL_TITLE_BOX="440 398 90 24"
      PROFILE_MARKER_BOX="340 192 220 22"
      LOGIN_TICK_BOX="441 625 28 28"
      # The rc builds render fine without the "unsupported command-line flag"
      # infobar, and that bar would shift every element below it. The classic
      # preset was measured with the bar visible, so only this layout asks for
      # --test-type, which is the switch that suppresses it.
      EXTRA_LAUNCH_FLAGS="--test-type"
      ;;
    *)
      USERNAME_XY="640 546"
      PASSWORD_XY="640 616"
      LOGIN_SHIELD_XY="458 745"
      LOGIN_BUTTON_XY="640 672"
      CHECKIN_BUTTON_XY="1166 506"
      MODAL_SHIELD_XY="509 550"
      CHECKIN_BUTTON_BOX="1120 498 92 20"
      MODAL_TITLE_BOX="437 425 150 26"
      PROFILE_MARKER_BOX="960 497 130 22"
      LOGIN_TICK_BOX="441 734 24 24"
      EXTRA_LAUNCH_FLAGS=""
      ;;
  esac
}

case "$SITE" in
  *motomoto.lol*) apply_layout moto ;;
  *chinahk.qzz.io*|*5201201314*) apply_layout rc ;;
  *) apply_layout classic ;;
esac

mkdir -p "$LOG"
say() { echo "[$(date '+%F %T')] $*" >> "$LOG/run.log"; }
emit() { printf 'METAPI_CHECKIN_RESULT={"ok":%s,"already":%s,"detail":"%s"}\n' "$1" "$2" "$3"; }

XVFB_PID=""
CHROMIUM_STARTED=0
WID=""
cleanup() {
  if [ "$CHROMIUM_STARTED" = 1 ]; then
    # The site's login cookie is session-only, so each run signs in again
    # (measured: a killed or restarted profile both come back signed out).
    # Killing instead of quitting still avoids Chromium's shutdown prompts and
    # keeps the profile's shield cookies; the crash bubble stays hidden through
    # --hide-crash-restore-bubble.
    pkill -u "$(id -u)" -f "$PROFILE" 2>/dev/null
    sleep 2
    pkill -9 -u "$(id -u)" -f "$PROFILE" 2>/dev/null
  fi
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null; fi
  find "$LOG" -name '*.ppm' -delete 2>/dev/null
}
trap cleanup EXIT

if [ -n "$PROXY" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -x "$PROXY" "$SITE/api/status" || true)
  if [ "$code" != "200" ]; then
    say "site unreachable through proxy (http $code)"
    emit false false site_unreachable
    exit 1
  fi
fi

display_ready() { xdotool getdisplaygeometry >/dev/null 2>&1; }

if ! display_ready; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    say "no live DISPLAY and no Xvfb"
    emit false false no_display
    exit 1
  fi
  Xvfb "$WANTED_DISPLAY" -screen 0 1440x1000x24 -nolisten tcp >"$LOG/xvfb.log" 2>&1 &
  XVFB_PID=$!
  export DISPLAY="$WANTED_DISPLAY"
  ok=0
  for _ in $(seq 1 20); do
    display_ready && { ok=1; break; }
    sleep 0.5
  done
  if [ "$ok" != 1 ]; then
    say "Xvfb did not come up on $WANTED_DISPLAY"
    emit false false no_display
    exit 1
  fi
fi

# The click coordinates below belong to a 1280x900 window on a display of at
# least 1440x1000; anything smaller would silently clip the page.
GEOMETRY=$(xdotool getdisplaygeometry 2>/dev/null || echo "0 0")
DISPLAY_W=${GEOMETRY%% *}
DISPLAY_H=${GEOMETRY##* }
say "display geometry ${DISPLAY_W}x${DISPLAY_H}"
if [ "${DISPLAY_W:-0}" -lt 1280 ] || [ "${DISPLAY_H:-0}" -lt 1000 ]; then
  say "display too small for the expected window layout"
  emit false false display_too_small
  exit 1
fi

[ -x "$BIN" ] || { say "chromium not found at $BIN"; emit false false no_browser; exit 1; }

pkill -u "$(id -u)" -f "$PROFILE" 2>/dev/null
sleep 1
rm -f "$PROFILE"/Singleton*
mkdir -p "$PROFILE"

if [ -n "$PROXY" ]; then
  setsid "$BIN" --user-data-dir="$PROFILE" --proxy-server="$PROXY" $EXTRA_LAUNCH_FLAGS \
    --no-first-run --no-default-browser-check \
    --hide-crash-restore-bubble --disable-save-password-bubble --password-store=basic \
    --disable-blink-features=AutomationControlled \
    --window-size=1280,900 --window-position=0,0 \
    about:blank < /dev/null > /dev/null 2>&1 &
else
  setsid "$BIN" --user-data-dir="$PROFILE" $EXTRA_LAUNCH_FLAGS \
    --no-first-run --no-default-browser-check \
    --hide-crash-restore-bubble --disable-save-password-bubble --password-store=basic \
    --disable-blink-features=AutomationControlled \
    --window-size=1280,900 --window-position=0,0 \
    about:blank < /dev/null > /dev/null 2>&1 &
fi
CHROMIUM_STARTED=1

for _ in $(seq 1 30); do
  WID=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  sleep 1
done
if [ -z "$WID" ]; then
  say "browser window never appeared"
  emit false false no_browser
  exit 1
fi
sleep 3

focus() { xdotool mousemove 600 28 click 1; sleep 0.4; }
nav() {
  focus
  xdotool key ctrl+l; sleep 0.4
  xdotool type --delay 20 "$1"; sleep 0.3
  xdotool key Return; sleep "$2"
}
snap() {
  xwd -root -silent > "$LOG/$1.xwd" 2>/dev/null
  xwdtopnm < "$LOG/$1.xwd" > "$LOG/$1.ppm" 2>/dev/null
  if command -v pnmtopng >/dev/null 2>&1; then
    pnmtopng < "$LOG/$1.ppm" > "$LOG/$1.png" 2>/dev/null
  fi
  rm -f "$LOG/$1.xwd"
}
measure() {
  # Classifies the check-in button (actionable vs already checked in), whether
  # the Security Check dialog is open, whether the profile page is really
  # rendered, and whether the login shield turned green. The colours that carry
  # those meanings differ per layout, so the boxes above and the palette below
  # travel together.
  local -a L=()
  mapfile -t L < <("$NODE" "$HELPER" "$LOG/cur.ppm" \
    $CHECKIN_BUTTON_BOX $MODAL_TITLE_BOX $PROFILE_MARKER_BOX $LOGIN_TICK_BOX \
    $OVERLAY_DIALOG_BOX $PWD_BUBBLE_BOX $CHECKIN_BADGE_BOX)
  local s=0 w=0 td=0 tb=0 pd=0 pg=0 g=0 gold=0 dull=0 og=0 pb=0 mbg=0 kv
  for kv in ${L[0]:-}; do case "$kv" in strong=*) s="${kv#strong=}";; weak=*) w="${kv#weak=}";; gold=*) gold="${kv#gold=}";; dull=*) dull="${kv#dull=}";; esac; done
  for kv in ${L[1]:-}; do case "$kv" in dark=*) td="${kv#dark=}";; bright=*) tb="${kv#bright=}";; esac; done
  for kv in ${L[2]:-}; do case "$kv" in dark=*) pd="${kv#dark=}";; green=*) pg="${kv#green=}";; esac; done
  for kv in ${L[3]:-}; do case "$kv" in green=*) g="${kv#green=}";; esac; done
  for kv in ${L[4]:-}; do case "$kv" in gold=*) og="${kv#gold=}";; esac; done
  for kv in ${L[5]:-}; do case "$kv" in bright=*) pb="${kv#bright=}";; esac; done
  for kv in ${L[6]:-}; do case "$kv" in green=*) mbg="${kv#green=}";; esac; done
  st=BLANK; modal=0; profile=0; tsolved=0; announce_dialog=0; pwd_bubble=0
  if [ "$LAYOUT" = moto ]; then
    # Amber palette: a bright amber button is the live control, while the
    # claimed state is announced by the small green check-in badge next to the
    # card title (the badge text width changes with the site language, so the
    # pixel count of the muted button alone cannot tell the states apart).
    if [ "$mbg" -gt 50 ]; then st=CHECKED
    elif [ "$gold" -gt 400 ]; then st=BLUE
    fi
    if [ "$tb" -gt 2000 ]; then modal=1; fi
    if [ "$pg" -gt 1000 ]; then profile=1; fi
  else
    if [ "$s" -gt 300 ]; then st=BLUE
    elif [ "$w" -gt 300 ]; then st=CHECKED
    fi
    if [ "$td" -gt 100 ]; then modal=1; fi
    if [ "$pd" -gt 200 ]; then profile=1; fi
  fi
  if [ "$g" -gt 50 ]; then tsolved=1; fi
  if [ "$og" -gt 500 ]; then announce_dialog=1; fi
  if [ "$pb" -gt 2000 ]; then pwd_bubble=1; fi
}

NODE=${NODE_BIN:-node}
HELPER=${CHECKIN_HELPER:-$(dirname "$0")/regionStats.mjs}
if [ ! -f "$HELPER" ]; then
  say "missing helper $HELPER"
  emit false false no_helper
  exit 1
fi

login() {
  local attempt=1 i
  while [ "$attempt" -le 3 ]; do
    say "sign-in attempt $attempt"
    xdotool mousemove $USERNAME_XY click 1; sleep 0.6
    xdotool key --clearmodifiers ctrl+a
    xdotool type --delay 40 "$USER_NAME"; sleep 0.4
    xdotool mousemove $PASSWORD_XY click 1; sleep 0.6
    xdotool key --clearmodifiers ctrl+a
    xdotool type --delay 40 "$USER_PASS"; sleep 0.4
    snap cur; measure; rm -f "$LOG/cur.ppm"
    if [ "$tsolved" = 0 ]; then
      xdotool mousemove $LOGIN_SHIELD_XY click 1
      i=0
      while [ "$i" -lt 8 ]; do
        sleep 2
        snap cur; measure; rm -f "$LOG/cur.ppm"
        [ "$tsolved" = 1 ] && break
        [ "$profile" = 1 ] && break
        i=$((i+1))
      done
    fi
    snap "login-form-$attempt"
    say "attempt$attempt shield=$tsolved"
    xdotool mousemove $LOGIN_BUTTON_XY click 1
    sleep 8
    snap "after-login-$attempt"
    snap cur; measure; rm -f "$LOG/cur.ppm"
    say "attempt$attempt profile=$profile state=$st"
    if [ "$profile" = 0 ]; then
      # Some builds land on a start page without the profile marker; look at
      # the real profile page before declaring the attempt a failure.
      nav "$SITE/profile" 8
      wait_profile
      say "attempt$attempt profile-after-nav=$profile state=$st"
    fi
    [ "$profile" = 1 ] && return 0
    attempt=$((attempt+1))
    sleep 2
  done
  return 1
}

nav "$SITE/profile" 8

# Waits for the profile page to render after a navigation.
wait_profile() {
  local n=0
  snap cur; measure; rm -f "$LOG/cur.ppm"
  while [ "$profile" = 0 ] && [ "$n" -lt 2 ]; do
    sleep 3
    snap cur; measure; rm -f "$LOG/cur.ppm"
    n=$((n+1))
  done
}

# Closes the floating panels that sit above the profile page and would swallow
# clicks. Only the moto layout defines their regions, so elsewhere this just
# leaves the current measurement in place.
dismiss_overlays() {
  [ "$LAYOUT" = moto ] || return 0
  local i
  # One click per pass: a dialog that is already closing would otherwise take
  # a second click, and that click would land on the page underneath.
  for i in 1 2 3 4; do
    snap cur; measure; rm -f "$LOG/cur.ppm"
    if [ "$pwd_bubble" = 1 ]; then
      say "dismissing the save-password bubble"
      xdotool mousemove $PWD_BUBBLE_DISMISS_XY click 1
      sleep 2
    elif [ "$announce_dialog" = 1 ]; then
      say "dismissing the announcement dialog"
      xdotool mousemove $ANNOUNCE_CLOSE_XY click 1
      sleep 2.5
    else
      break
    fi
  done
}

wait_profile
dismiss_overlays
say "state1=$st modal=$modal profile=$profile"

if [ "$profile" = 0 ]; then
  # Always return to the page that carries the check-in card afterwards: the
  # sign-in may land on a different start page (the rc build opens its
  # overview), and even a failed attempt deserves one last look before the
  # flow gives up.
  login || true
  nav "$SITE/profile" 8
  wait_profile
  dismiss_overlays
  if [ "$profile" = 0 ]; then
    snap result
    say "sign-in never reached the profile page"
    emit false false login_failed
    exit 1
  fi
fi

if [ "$st" = CHECKED ]; then
  snap result
  say "already checked in today"
  emit true true already_checked_in
  exit 0
fi

say "clicking Check in now"
xdotool mousemove $CHECKIN_BUTTON_XY click 1
sleep 4
snap cur; measure; rm -f "$LOG/cur.ppm"
say "state3=$st modal=$modal"
if [ "$modal" = 1 ]; then xdotool mousemove $MODAL_SHIELD_XY click 1; fi

n=0
while [ "$n" -lt 8 ]; do
  sleep 6
  snap cur; measure; rm -f "$LOG/cur.ppm"
  say "poll$n state=$st modal=$modal"
  if [ "$st" = CHECKED ]; then
    snap result
    say "check-in completed"
    emit true false checked_in
    exit 0
  fi
  if [ "$modal" = 1 ]; then
    if [ "$n" -lt 3 ]; then xdotool mousemove $MODAL_SHIELD_XY click 1; fi
  elif [ "$st" = BLUE ] && [ "$n" -lt 2 ]; then
    xdotool mousemove $CHECKIN_BUTTON_XY click 1
    sleep 3
    xdotool mousemove $MODAL_SHIELD_XY click 1
  fi
  n=$((n+1))
done
snap result
say "check-in did not complete (state=$st modal=$modal)"
emit false false checkin_failed
exit 1
