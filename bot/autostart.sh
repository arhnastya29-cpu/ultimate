#!/bin/zsh
# Автозапуск бота и Ollama при входе в систему (launchd). Повторный запуск — переустановка.
# Снять автозапуск: bot/autostart.sh off
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PL=~/Library/LaunchAgents
mkdir -p "$PL"
if [[ "$1" == "off" ]]; then
  launchctl bootout gui/$(id -u) "$PL/com.ultimate.bot.plist" 2>/dev/null || true
  launchctl bootout gui/$(id -u) "$PL/com.ultimate.ollama.plist" 2>/dev/null || true
  rm -f "$PL/com.ultimate.bot.plist" "$PL/com.ultimate.ollama.plist"
  echo "Автозапуск выключен"; exit 0
fi
cat > "$PL/com.ultimate.ollama.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ultimate.ollama</string>
  <key>ProgramArguments</key><array><string>/Applications/Ollama.app/Contents/Resources/ollama</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ultimate-ollama.log</string><key>StandardErrorPath</key><string>/tmp/ultimate-ollama.log</string>
</dict></plist>
P
cat > "$PL/com.ultimate.bot.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ultimate.bot</string>
  <key>ProgramArguments</key><array><string>$DIR/bot/.venv/bin/python</string><string>$DIR/bot/ultimate_bot.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/bot/bot.log</string><key>StandardErrorPath</key><string>$DIR/bot/bot.log</string>
</dict></plist>
P
for n in com.ultimate.ollama com.ultimate.bot; do
  launchctl bootout gui/$(id -u) "$PL/$n.plist" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$PL/$n.plist"
done
echo "Автозапуск включён: Ollama и бот стартуют при входе и перезапускаются сами. Журнал: bot/bot.log"
