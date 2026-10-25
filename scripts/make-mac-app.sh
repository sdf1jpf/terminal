#!/bin/sh
# Builds "Mainframe Terminal.app", a double-clickable launcher for macOS.
# It opens a Terminal window and runs the client against the API, so it can
# live in the Dock, Launchpad or Spotlight.
#
#   scripts/make-mac-app.sh [api-url]
#
# The app goes in ~/Applications (set DEST to change that). Run the script
# again after pulling changes to rebuild the client inside the app.
set -eu

API_URL=${1:-https://customer-api.justin-frank.workers.dev}
APP_NAME="Mainframe Terminal"
DEST=${DEST:-$HOME/Applications}
APP="$DEST/$APP_NAME.app"

if [ "$(uname)" != Darwin ]; then
	echo "make-mac-app.sh: this only works on macOS" >&2
	exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p "$DEST"
rm -rf "$APP"

# The launcher is a small AppleScript app. It tells Terminal to run the
# client bundled inside the app, then sizes the window. The screen grows to
# fill the window, so a bigger window gives a bigger presentation space.
osacompile -o "$APP" <<APPLESCRIPT
set bin to quoted form of (POSIX path of (path to me) & "Contents/Resources/terminal")
tell application "Terminal"
	activate
	do script bin & " -api " & quoted form of "$API_URL" & "; exit"
	delay 0.2
	set number of columns of front window to 100
	set number of rows of front window to 32
end tell
APPLESCRIPT

go build -o "$APP/Contents/Resources/terminal" ./cmd/terminal

echo "Built $APP"
echo "Open it from Launchpad or Spotlight, or drag it to the Dock."
