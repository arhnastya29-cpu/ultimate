#!/bin/zsh
# Запуск бота вручную (двойной клик). Останавливается закрытием окна или Ctrl+C.
cd "$(dirname "$0")/.."
OLLAMA=/Applications/Ollama.app/Contents/Resources/ollama
if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Запускаю Ollama…"; (nohup "$OLLAMA" serve >/tmp/ollama.log 2>&1 &); sleep 3
fi
exec bot/.venv/bin/python bot/ultimate_bot.py
