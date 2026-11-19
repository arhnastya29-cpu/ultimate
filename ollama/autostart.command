#!/bin/zsh
# Локальная модель для ULTIMATE. Двойной клик — и Ollama будет запускаться при каждом входе в Mac
# и перезапускаться сама. OLLAMA_ORIGINS разрешает приложению в браузере обращаться к модели.
# Выключить: запустить в Терминале   ollama/autostart.command off
PL=~/Library/LaunchAgents; mkdir -p "$PL"
if [[ "$1" == "off" ]]; then
  launchctl bootout gui/$(id -u) "$PL/com.ultimate.ollama.plist" 2>/dev/null || true
  rm -f "$PL/com.ultimate.ollama.plist"; echo "Автозапуск Ollama выключен"; exit 0
fi
cat > "$PL/com.ultimate.ollama.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ultimate.ollama</string>
  <key>ProgramArguments</key><array><string>/Applications/Ollama.app/Contents/Resources/ollama</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>OLLAMA_ORIGINS</key><string>*</string><key>OLLAMA_KEEP_ALIVE</key><string>30m</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ultimate-ollama.log</string><key>StandardErrorPath</key><string>/tmp/ultimate-ollama.log</string>
</dict></plist>
P
launchctl bootout gui/$(id -u) "$PL/com.ultimate.ollama.plist" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PL/com.ultimate.ollama.plist"
echo "Готово: Ollama запускается автоматически. Можно закрыть окно."
