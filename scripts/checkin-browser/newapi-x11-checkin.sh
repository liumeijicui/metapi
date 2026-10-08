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
#   CHECKIN_PASSWORD      login password; may be empty when the session below
#                         is seeded, because nothing is typed in that case
#   CHECKIN_PROFILE_DIR   Chromium user-data-dir (login session is kept here)
#   CHECKIN_LOG_DIR       screenshots + run.log for this run
#   CHECKIN_PROXY_URL     optional http(s) proxy for the browser
#   CHECKIN_COOKIE_NAME   login cookie to leave in the profile before exiting
#   CHECKIN_DISPLAY       X display to use when none is alive (default :99)
#   CHROMIUM_BIN          optional chromium executable override
#
# CHECKIN_COOKIE_NAME is what turns the browser session into a credential the
# caller can keep using: the named cookie is cleared before the run and the flow
# then waits for the freshly written value to reach the profile, because
# Chromium's cookie store only commits on a ~30s timer and never flushes on exit.
#
# CHECKIN_SESSION_SEEDED=1 tells the flow the caller has already written a live
# login cookie into the profile. The site then opens on the signed-in page and
# there is nothing to type, so the sign-in path is skipped entirely: these
# builds sign in through an OAuth redirect, which has no password field to
# drive, and a run that typed an empty password would only look like a failure.
#
# CHECKIN_COOKIE_PREVIOUS is the value the caller just planted. A rolling
# credential is rotated by the first exchange the page makes, so the flow waits
# for the stored value to *change* rather than to merely exist: the planted value
# is already there, and keeping it would hand the caller back a spent secret.
#
# Output contract: the last stdout line is
#   METAPI_CHECKIN_RESULT={"ok":<bool>,"already":<bool>,"detail":"<token>"}
# Exit code 0 only when ok or already is true.
set -u

SITE=${CHECKIN_SITE_URL:?CHECKIN_SITE_URL is required}
USER_NAME=${CHECKIN_USERNAME:?CHECKIN_USERNAME is required}
# A run that starts from a session the caller already planted never types a
# password, so the caller is allowed to leave it empty.
USER_PASS=${CHECKIN_PASSWORD:-}
PROFILE=${CHECKIN_PROFILE_DIR:?CHECKIN_PROFILE_DIR is required}
LOG=${CHECKIN_LOG_DIR:-/tmp/metapi-checkin-browser}
PROXY=${CHECKIN_PROXY_URL:-}
WANTED_DISPLAY=${CHECKIN_DISPLAY:-:99}
BIN=${CHROMIUM_BIN:-/usr/bin/chromium-browser}
NODE=${NODE_BIN:-node}
HELPER=${CHECKIN_HELPER:-$(dirname "$0")/regionStats.mjs}
COOKIE_HELPER=$(dirname "$0")/cookieStore.mjs
CHALLENGE_HELPER=$(dirname "$0")/challengeLocator.mjs
COOKIE_NAME=${CHECKIN_COOKIE_NAME:-}
SESSION_SEEDED=${CHECKIN_SESSION_SEEDED:-}
COOKIE_PREVIOUS=${CHECKIN_COOKIE_PREVIOUS:-}

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
  # How the overlay probe reads `OVERLAY_DIALOG_BOX`: a warm banner (gold) or a
  # dark-theme modal filled with strong blue. 0 means "not measured".
  OVERLAY_DIALOG_STRONG=0
  # Some builds raise their announcement dialog a few seconds *after* the page
  # renders, so a single look can miss it and the dialog then swallows every
  # keystroke aimed at the form. This is how long to keep looking, in seconds.
  OVERLAY_WAIT_SECONDS=0
  PWD_BUBBLE_BOX="0 0 0 0"
  CHECKIN_BADGE_BOX="0 0 0 0"
  EXTRA_LAUNCH_FLAGS=""
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
      # Wide enough to still catch the button if the card's content shifts it:
      # this layout's click point is read back out of this box (see
      # click_checkin), so the box is a search area, not just a yes/no probe.
      CHECKIN_BUTTON_BOX="1100 430 170 50"
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
    kkt)
      # kktoken.cc (KKtoken AI). Its sign-in page carries a GitHub button above
      # the form, so that form sits where the moto layout measured it; the build
      # itself is a plain blue one, so the check-in button follows the rc
      # palette (saturated blue = actionable, pale blue = checked in today).
      # The profile page is a wide dashboard: the check-in card is the rightmost
      # tile of the second row, and its button only shows up once the page has
      # been rendered for a moment.
      USERNAME_XY="640 484"
      PASSWORD_XY="640 554"
      LOGIN_SHIELD_XY="455 681"
      LOGIN_BUTTON_XY="640 609"
      CHECKIN_BUTTON_XY="1168 454"
      MODAL_SHIELD_XY="508 525"
      CHECKIN_BUTTON_BOX="1114 440 108 28"
      MODAL_TITLE_BOX="400 400 200 24"
      # The signed-in header carries the user name; the sign-in page is blank
      # in that spot.
      PROFILE_MARKER_BOX="338 190 160 26"
      LOGIN_TICK_BOX="440 718 30 28"
      EXTRA_LAUNCH_FLAGS="--test-type"
      ;;
    jdw)
      # JustDoWork (api.justwoker.icu). It ships a different sign-in page from
      # every other build here: its own `/sign-in` route with a GitHub button on
      # top, a password form under it and Turnstile below that. The profile page
      # is a dark dashboard whose check-in card sits on the left column.
      USERNAME_XY="640 491"
      PASSWORD_XY="640 562"
      LOGIN_SHIELD_XY="452 683"
      LOGIN_BUTTON_XY="640 611"
      CHECKIN_BUTTON_XY="1166 506"
      MODAL_SHIELD_XY="509 550"
      CHECKIN_BUTTON_BOX="1100 430 170 50"
      MODAL_TITLE_BOX="437 425 150 26"
      PROFILE_MARKER_BOX="960 497 130 22"
      LOGIN_TICK_BOX="435 666 55 40"
      EXTRA_LAUNCH_FLAGS="--test-type"
      # The sign-in page opens with the site's announcement dialog (a Discord QR
      # card) sitting on top of the form: typing then goes into the dialog and
      # every attempt ends on a blank page. The probe watches the dialog's own
      # Close button rather than the QR panel, because that panel has two paint
      # states (a blue placeholder, then the loaded code) and only one of them
      # would match any single palette rule. The dialog is also slow to appear,
      # hence the wait.
      OVERLAY_DIALOG_BOX="810 745 80 30"
      OVERLAY_DIALOG_STRONG=300
      OVERLAY_WAIT_SECONDS=30
      ANNOUNCE_CLOSE_XY="850 761"
      ;;
    ark)
      # 方舟 (api.bxacc.xyz). Its sign-in form is taller than the other builds:
      # a LinuxDO button sits above the fields, so everything is ~70px lower
      # than on the rc layout. Measured with the infobar visible, hence no
      # --test-type.
      USERNAME_XY="640 512"
      PASSWORD_XY="640 584"
      LOGIN_SHIELD_XY="458 715"
      LOGIN_BUTTON_XY="640 638"
      CHECKIN_BUTTON_XY="1166 506"
      MODAL_SHIELD_XY="509 550"
      CHECKIN_BUTTON_BOX="1113 489 112 34"
      MODAL_TITLE_BOX="437 425 150 26"
      # The profile page is the only one that renders the check-in totals row.
      PROFILE_MARKER_BOX="900 655 340 45"
      LOGIN_TICK_BOX="441 692 60 45"
      # Chromium's save-password bubble covers the check-in card on this build.
      PWD_BUBBLE_BOX="850 95 300 40"
      PWD_BUBBLE_DISMISS_XY="1126 114"
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
  *kktoken.cc*) apply_layout kkt ;;
  *motomoto.lol*) apply_layout moto ;;
  *chinahk.qzz.io*|*5201201314*) apply_layout rc ;;
  *bxacc.xyz*) apply_layout ark ;;
  *justwoker.icu*) apply_layout jdw ;;
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
    # Let Chromium exit on its own before forcing it: the caller reads this
    # profile's login cookie right after the run, and a browser killed mid-write
    # leaves both a dirty profile and a cookie store it was still updating. The
    # kill that follows is only the fallback for a browser that ignores the
    # signal; the crash bubble stays hidden through --hide-crash-restore-bubble.
    pkill -u "$(id -u)" -f "$PROFILE" 2>/dev/null
    for _ in $(seq 1 30); do
      pgrep -u "$(id -u)" -f "$PROFILE" >/dev/null 2>&1 || break
      sleep 0.5
    done
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

# The caller reads the login cookie this run writes, so drop whatever an earlier
# run left behind: "the cookie is in the store" then means "this run wrote it".
# A caller that planted a live session is the exception: that cookie is the one
# the browser has to start with, and the wait below tracks it by value instead.
if [ -n "$COOKIE_NAME" ] && [ "$SESSION_SEEDED" != 1 ]; then
  "$NODE" "$COOKIE_HELPER" drop "$PROFILE" "$COOKIE_NAME" >/dev/null 2>&1 || true
fi

if [ -n "$PROXY" ]; then
  setsid "$BIN" --user-data-dir="$PROFILE" --proxy-server="$PROXY" $EXTRA_LAUNCH_FLAGS \
    --remote-debugging-port=0 \
    --no-first-run --no-default-browser-check \
    --hide-crash-restore-bubble --disable-save-password-bubble --password-store=basic \
    --disable-blink-features=AutomationControlled \
    --window-size=1280,900 --window-position=0,0 \
    about:blank < /dev/null > /dev/null 2>&1 &
else
  setsid "$BIN" --user-data-dir="$PROFILE" $EXTRA_LAUNCH_FLAGS \
    --remote-debugging-port=0 \
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
  local s=0 w=0 td=0 tb=0 pd=0 pg=0 g=0 gold=0 dull=0 og=0 os=0 pb=0 mbg=0 kv
  # Reset before every measure: a stale centroid from the previous frame would
  # send the click to where the button used to be.
  gold_cx=0; gold_cy=0
  for kv in ${L[0]:-}; do case "$kv" in strong=*) s="${kv#strong=}";; weak=*) w="${kv#weak=}";; gold=*) gold="${kv#gold=}";; dull=*) dull="${kv#dull=}";; goldCx=*) gold_cx="${kv#goldCx=}";; goldCy=*) gold_cy="${kv#goldCy=}";; esac; done
  for kv in ${L[1]:-}; do case "$kv" in dark=*) td="${kv#dark=}";; bright=*) tb="${kv#bright=}";; esac; done
  for kv in ${L[2]:-}; do case "$kv" in dark=*) pd="${kv#dark=}";; green=*) pg="${kv#green=}";; esac; done
  for kv in ${L[3]:-}; do case "$kv" in green=*) g="${kv#green=}";; esac; done
  for kv in ${L[4]:-}; do case "$kv" in gold=*) og="${kv#gold=}";; strong=*) os="${kv#strong=}";; esac; done
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
  if [ "$OVERLAY_DIALOG_STRONG" -gt 0 ] && [ "$os" -gt "$OVERLAY_DIALOG_STRONG" ]; then announce_dialog=1; fi
  if [ "$pb" -gt 2000 ]; then pwd_bubble=1; fi
}

if [ ! -f "$HELPER" ]; then
  say "missing helper $HELPER"
  emit false false no_helper
  exit 1
fi

# Clicks the Turnstile checkbox wherever it actually is.
#
# The layout presets carry a measured coordinate, and that is what breaks on a
# site whose card renders a little differently: the click lands on empty page,
# the widget never turns green, and the run reports a failed sign-in for a
# password that was fine. The locator reads the widget's real box out of the
# live DOM instead, which is also the only way to reach it when Cloudflare
# nests the frame in a shadow root. The preset stays as the fallback for a
# browser that has not published its DevTools endpoint yet.
#
# Clicks the checkbox of the challenge that is on screen, using the position the
# live DOM reports. Returns non-zero when no widget is mounted at all.
#
# `solved` is the locator saying the challenge already has a token: there is
# nothing to click, and clicking anyway can restart it.
shield_click_located() {
  local out="" x="" y=""
  [ -f "$CHALLENGE_HELPER" ] || return 1
  out=$("$NODE" "$CHALLENGE_HELPER" "$PROFILE" 2>/dev/null | tail -1)
  case "$out" in
    solved)
      say "Turnstile challenge already solved"
      return 0
      ;;
    x=*)
      x=$(printf '%s' "$out" | sed -n 's/.*x=\([0-9][0-9]*\).*/\1/p')
      y=$(printf '%s' "$out" | sed -n 's/.*y=\([0-9][0-9]*\).*/\1/p')
      ;;
    *) return 1 ;;
  esac
  if [ -z "$x" ] || [ -z "$y" ]; then return 1; fi
  say "clicking the Turnstile checkbox at $x $y (located)"
  xdotool mousemove "$x" "$y"; sleep 0.4
  xdotool click 1
  return 0
}

# The coordinate to use when the DOM cannot be read. The check-in dialog raises
# the same widget as the sign-in page but not at the same height on every build,
# so each call site passes the preset measured for its own screen; that preset
# is the fallback, never the first choice.
click_shield() {
  local fallback="${1:-$LOGIN_SHIELD_XY}"
  shield_click_located && return 0
  say "Turnstile widget not located; falling back to $fallback"
  xdotool mousemove $fallback click 1
}

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
      click_shield
      i=0
      while [ "$i" -lt 8 ]; do
        sleep 2
        snap cur; measure; rm -f "$LOG/cur.ppm"
        [ "$tsolved" = 1 ] && break
        [ "$profile" = 1 ] && break
        # Cloudflare sometimes replaces the widget right as it is clicked, and
        # a click sent before it finished mounting is simply lost. Re-reading
        # the position once mid-wait is enough to catch both without hammering
        # the widget, which is its own reason to be refused.
        if [ "$i" = 4 ]; then click_shield; fi
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

# Waits for the profile page to render after a navigation, and then for its
# check-in card to render too: the signed-in header can appear several seconds
# before the card's button does, and a click that lands before the button exists
# is simply lost.
wait_profile() {
  local n=0
  snap cur; measure; rm -f "$LOG/cur.ppm"
  while [ "$profile" = 0 ] && [ "$n" -lt 2 ]; do
    sleep 3
    snap cur; measure; rm -f "$LOG/cur.ppm"
    n=$((n+1))
  done
  n=0
  while [ "$profile" = 1 ] && [ "$st" = BLANK ] && [ "$n" -lt 3 ]; do
    sleep 3
    snap cur; measure; rm -f "$LOG/cur.ppm"
    n=$((n+1))
  done
}

# Closes the floating panels that sit above the page and would swallow clicks.
# Only the layouts that define those regions do anything here; the rest return
# with the current measurement untouched.
dismiss_overlays() {
  [ "$OVERLAY_DIALOG_BOX" = "0 0 0 0" ] && [ "$PWD_BUBBLE_BOX" = "0 0 0 0" ] && return 0
  local i
  # Give a late dialog a chance to show up before deciding there is none.
  local waited=0
  while [ "$waited" -lt "$OVERLAY_WAIT_SECONDS" ]; do
    snap cur; measure; rm -f "$LOG/cur.ppm"
    if [ "$announce_dialog" = 1 ] || [ "$pwd_bubble" = 1 ]; then break; fi
    sleep 2
    waited=$((waited + 2))
  done
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

# Chromium commits its cookie store on a ~30s timer and never flushes it on
# exit, so the login cookie only reaches the profile while the window is still
# open. The caller exchanges that cookie for a plain HTTP credential once this
# script is done, so hold the run open until the value has landed.
wait_for_login_cookie() {
  [ -n "$COOKIE_NAME" ] || return 0
  local waited
  if waited=$("$NODE" "$COOKIE_HELPER" wait "$PROFILE" "$COOKIE_NAME" \
    "${CHECKIN_COOKIE_WAIT_SECONDS:-60}" "$COOKIE_PREVIOUS" 2>/dev/null); then
    say "login cookie stored in the profile ($waited)"
  else
    say "login cookie never reached the profile"
  fi
}

wait_profile
dismiss_overlays
say "state1=$st modal=$modal profile=$profile"

if [ "$profile" = 0 ]; then
  if [ "$SESSION_SEEDED" = 1 ]; then
    # The caller planted a login cookie and the site still opened signed out,
    # so that cookie was already spent. An OAuth-only build has no password
    # field to type into, and pretending to sign in would report a failure
    # that names the wrong cause, so say what actually happened.
    snap result
    say "seeded session did not open the profile page"
    emit false false session_rejected
    exit 1
  fi
  # Always return to the page that carries the check-in card afterwards: the
  # sign-in may land on a different start page (the rc build opens its
  # overview), and even a failed attempt deserves one last look before the
  # flow gives up.
  login || true
  # A run that already measured the signed-in profile is done. Navigating a
  # second time is not harmless: on a site that re-checks the session on every
  # full page load (chinahk) the fresh cookie is refused the moment the page is
  # reloaded, the site bounces back to sign-in, and a successful sign-in is
  # reported as `login_failed`. Only reload when the attempt really did land
  # somewhere without the marker.
  if [ "$profile" = 0 ]; then
    nav "$SITE/profile" 8
    wait_profile
    dismiss_overlays
  fi
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
  wait_for_login_cookie
  emit true true already_checked_in
  exit 0
fi

# Clicks the check-in control.
#
# The presets above are measurements, and a measured point goes stale the moment
# the card moves: motomoto's amber button sits at x≈1195 while the preset still
# says 1161, and a click 34px to the left of a pill lands on the card behind it —
# silently, with the page state never changing. So for the warm layout the click
# follows the pixels: `measure` reports where the amber control actually is, and
# the preset stays as the fallback for a frame that had no match at all.
click_checkin() {
  if [ "$LAYOUT" = moto ] && [ "${gold_cx:-0}" -gt 0 ] && [ "${gold_cy:-0}" -gt 0 ]; then
    say "clicking Check in now at $gold_cx $gold_cy"
    xdotool mousemove "$gold_cx" "$gold_cy" click 1
    return
  fi
  say "clicking Check in now at $CHECKIN_BUTTON_XY"
  xdotool mousemove $CHECKIN_BUTTON_XY click 1
}

click_checkin
sleep 4
snap cur; measure; rm -f "$LOG/cur.ppm"
say "state3=$st modal=$modal"
# The dialog can carry the widget even when the title probe above reads the
# screen wrong, so look for the widget itself first; only a page with no widget
# anywhere falls back to the preset. `modal` still decides when to wait for a
# dialog to appear, because a widget that mounts late is otherwise missed.
if [ "$modal" = 1 ]; then click_shield "$MODAL_SHIELD_XY"; else shield_click_located || true; fi

n=0
while [ "$n" -lt 8 ]; do
  sleep 6
  snap cur; measure; rm -f "$LOG/cur.ppm"
  say "poll$n state=$st modal=$modal"
  if [ "$st" = CHECKED ]; then
    snap result
    say "check-in completed"
    wait_for_login_cookie
    emit true false checked_in
    exit 0
  fi
  if [ "$modal" = 1 ]; then
    if [ "$n" -lt 3 ]; then click_shield "$MODAL_SHIELD_XY"; fi
  elif shield_click_located; then
    # A challenge is up even though the dialog probe did not see it. Answering it
    # is the only action the dialog needs, so this outranks the retry below: the
    # button behind the overlay still measures as actionable, and clicking it
    # again would aim at a modal instead of the page.
    :
  elif [ "$st" = BLUE ] && [ "$n" -lt 2 ]; then
    click_checkin
    sleep 3
    click_shield "$MODAL_SHIELD_XY"
  fi
  n=$((n+1))
done
snap result
say "check-in did not complete (state=$st modal=$modal)"
emit false false checkin_failed
exit 1
