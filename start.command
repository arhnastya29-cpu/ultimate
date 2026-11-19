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
# Сервер на этом порту всегда перезапускаем: так после обновления приложения точно работает свежая версия.
if lsof -i :$PORT >/dev/null 2>&1; then
  lsof -ti :$PORT | xargs kill 2>/dev/null; sleep 1
fi
nohup "$PY" serve.py $PORT >/dev/null 2>&1 &
sleep 1
open "http://127.0.0.1:$PORT/"
