#!/bin/sh
# Builds TasksBar.app (menu-bar only) into ./build. Copy it to /Applications and add it to
# System Settings > General > Login Items to start it at login.
set -e
cd "$(dirname "$0")"
swift build -c release
APP=build/TasksBar.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/TasksBar "$APP/Contents/MacOS/TasksBar"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TasksBar</string>
  <key>CFBundleIdentifier</key><string>com.tasks.bar</string>
  <key>CFBundleExecutable</key><string>TasksBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF
codesign --force --sign - "$APP" 2>/dev/null || true
echo "Built $APP"
