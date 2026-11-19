#!/bin/bash
# Запуск ULTIMATE: локальный сервер + открытие в браузере.
cd "$(dirname "$0")"
PORT=8765
PY=""
for c in python3 "$HOME/.local/bin/python3" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Не найден python3. Установите Python с python.org и запустите снова."; read -r -p "Нажмите Enter…"; exit 1
fi
# Если на порту уже старый сервер без загрузчика лент — остановим его и запустим новый.
if lsof -i :$PORT >/dev/null 2>&1; then
  if ! curl -s --max-time 2 "http://127.0.0.1:$PORT/__ping" | grep -q ultimate; then
    lsof -ti :$PORT | xargs kill 2>/dev/null; sleep 1
  fi
fi
if ! lsof -i :$PORT >/dev/null 2>&1; then
  nohup "$PY" serve.py $PORT >/dev/null 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:$PORT/"
