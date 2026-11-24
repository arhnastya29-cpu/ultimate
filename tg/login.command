#!/bin/zsh
# Вход в Telegram для раздела «Чаты» в ULTIMATE. Двойной клик — и следуйте вопросам в этом окне.
# Нужны два ключа с сайта https://my.telegram.org («API development tools»): api_id и api_hash.
# Они, как и вход, остаются только на этом Mac (tg/config.json и tg/ultimate.session не попадают в репозиторий).
cd "$(dirname "$0")"
PY=""
for c in python3 "$HOME/.local/bin/python3" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [[ -z "$PY" ]]; then echo "Не найден python3. Установите Python с python.org и запустите снова."; read -r "?Нажмите Enter…"; exit 1; fi
if [[ ! -x .venv/bin/python ]]; then
  echo "Готовлю окружение (один раз, около минуты)…"
  "$PY" -m venv .venv && .venv/bin/python -m pip install -q --disable-pip-version-check telethon || { echo "Не удалось установить библиотеку Telethon"; read -r "?Нажмите Enter…"; exit 1; }
fi
if [[ ! -f config.json ]]; then
  echo "Откройте https://my.telegram.org → API development tools, создайте приложение (любое название) и скопируйте ключи."
  read -r "APP_ID?api_id (число): "
  read -r "APP_HASH?api_hash: "
  printf '{"api_id": %s, "api_hash": "%s"}\n' "${APP_ID//[^0-9]/}" "$APP_HASH" > config.json
fi
echo "Сейчас Telegram спросит номер телефона (в международном формате, например +79991234567), затем код из приложения Telegram."
.venv/bin/python collect.py --login
echo
echo "Первый сбор сообщений (до нескольких минут)…"
.venv/bin/python collect.py
echo
echo "Готово. Откройте ULTIMATE → Чаты. Окно можно закрыть."
read -r "?Нажмите Enter…"
