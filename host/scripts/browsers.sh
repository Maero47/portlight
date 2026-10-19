# Shared by install.sh / uninstall.sh. Defines INSTALL_DIR and for_each_browser.
# Per-user NativeMessagingHosts locations; the profile dir existing means "installed".

case "$(uname -s)" in
  Darwin)
    INSTALL_DIR="$HOME/Library/Application Support/Portlight/host"
    for_each_browser() {
      as="$HOME/Library/Application Support"
      "$1" "Google Chrome"        "$as/Google/Chrome"
      "$1" "Google Chrome Beta"   "$as/Google/Chrome Beta"
      "$1" "Google Chrome Dev"    "$as/Google/Chrome Dev"
      "$1" "Google Chrome Canary" "$as/Google/Chrome Canary"
      "$1" "Chromium"             "$as/Chromium"
      "$1" "Brave"                "$as/BraveSoftware/Brave-Browser"
      "$1" "Microsoft Edge"       "$as/Microsoft Edge"
      "$1" "Microsoft Edge Beta"  "$as/Microsoft Edge Beta"
      "$1" "Microsoft Edge Dev"   "$as/Microsoft Edge Dev"
      "$1" "Arc"                  "$as/Arc/User Data"
      "$1" "Vivaldi"              "$as/Vivaldi"
    }
    ;;
  Linux)
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/portlight/host"
    for_each_browser() {
      cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
      "$1" "Google Chrome"          "$cfg/google-chrome"
      "$1" "Google Chrome Beta"     "$cfg/google-chrome-beta"
      "$1" "Google Chrome Unstable" "$cfg/google-chrome-unstable"
      "$1" "Chromium"               "$cfg/chromium"
      "$1" "Brave"                  "$cfg/BraveSoftware/Brave-Browser"
      "$1" "Microsoft Edge"         "$cfg/microsoft-edge"
      "$1" "Microsoft Edge Beta"    "$cfg/microsoft-edge-beta"
      "$1" "Microsoft Edge Dev"     "$cfg/microsoft-edge-dev"
      "$1" "Vivaldi"                "$cfg/vivaldi"
    }
    ;;
  *)
    echo "error: unsupported OS $(uname -s); on Windows use install.ps1" >&2
    exit 1
    ;;
esac
