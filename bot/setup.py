"""Настройка бота: спрашивает токен Telegram и пароль синхронизации, проверяет доступ к данным
и к модели, сохраняет bot/config.json (только на этом Mac, права 600) и показывает код привязки."""
import getpass, json, os, secrets, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault as V
import llm
from tg import Telegram

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'config.json')


def main():
    print('Настройка бота ULTIMATE\n')
    cfg = {}
    if os.path.exists(CONFIG):
        try:
            cfg = json.load(open(CONFIG))
        except Exception:
            cfg = {}
    token = input(f"1) Токен бота из @BotFather{' [оставить текущий]' if cfg.get('telegram_token') else ''}: ").strip() or cfg.get('telegram_token', '')
    if not token:
        sys.exit('Без токена не получится. Создайте бота в Telegram: @BotFather → /newbot.')
    try:
        me = Telegram(token).me()
        print(f"   ок, бот @{me.get('username')}")
    except Exception as e:
        sys.exit('   Telegram не принял токен: ' + str(e))

    pw = getpass.getpass(f"2) Пароль синхронизации ULTIMATE (не показывается){' [Enter — оставить]' if cfg.get('sync_password') else ''}: ") or cfg.get('sync_password', '')
    if not pw:
        sys.exit('Без пароля бот не сможет читать данные.')
    v = V.Vault(pw)
    print('   проверяю облако…')
    try:
        state, version = v.pull()
    except V.VaultError as e:
        sys.exit('   ' + str(e))
    if state is None:
        sys.exit('   С таким паролем в облаке ничего нет. Включите синхронизацию в приложении тем же паролем.')
    n = sum(len(x) for x in state.get('collections', {}).values())
    print(f'   ок, записей в облаке: {n}')

    model = input('3) Модель Ollama [qwen2.5:14b]: ').strip() or cfg.get('model', 'qwen2.5:14b')
    ok, names = llm.available(model)
    print('   ок, модель найдена' if ok else f'   модель пока не скачана (есть: {names or "ничего"}). Бот запустится, но отвечать начнёт после скачивания.')
    mh = input(f"4) Час утренней сводки [{cfg.get('morning_hour', 8)}]: ").strip() or cfg.get('morning_hour', 8)
    eh = input(f"5) Час вечернего вопроса [{cfg.get('evening_hour', 21)}]: ").strip() or cfg.get('evening_hour', 21)

    code = cfg.get('pair_code') or secrets.token_hex(3)
    cfg.update({'telegram_token': token, 'sync_password': pw, 'model': model, 'morning_hour': int(mh), 'evening_hour': int(eh), 'pair_code': code})
    with open(CONFIG, 'w') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(CONFIG, 0o600)
    print(f"\nГотово. Настройки сохранены в {CONFIG} (видны только вам).")
    print(f"\nДальше: запустите бота (bot/start.command или автозапуск), откройте @{me.get('username')} в Telegram и отправьте ему:\n\n   /start {code}\n")


if __name__ == '__main__':
    main()
