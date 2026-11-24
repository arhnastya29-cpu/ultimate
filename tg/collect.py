#!/usr/bin/env python3
"""Сбор сообщений из Telegram для раздела «Чаты» в ULTIMATE.

Читает личные чаты и группы (каналы и ботов пропускает) от имени пользователя через
официальный клиентский API Telegram (библиотека Telethon). Всё остаётся на этом Mac:
ключи — в tg/config.json, вход — в tg/ultimate.session, сообщения — в tg/data/messages.json.

  python3 collect.py            — дособрать новые сообщения (первый раз: за последние 7 дней)
  python3 collect.py --status   — только проверить, выполнен ли вход
  python3 collect.py --login    — интерактивный вход (номер телефона, код из Telegram)
"""
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'config.json')
SESSION = os.path.join(HERE, 'ultimate')
DATA_DIR = os.path.join(HERE, 'data')
DATA = os.path.join(DATA_DIR, 'messages.json')
KEEP_DAYS = 14          # сколько дней держим сообщения
FIRST_DAYS = 7          # глубина первого сбора
MAX_PER_CHAT = 300      # не больше сообщений на чат за один сбор
MAX_CHATS = 200         # самые свежие диалоги


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def load_config():
    try:
        with open(CONFIG, encoding='utf-8') as f:
            c = json.load(f)
        return int(c['api_id']), str(c['api_hash'])
    except Exception:
        return None, None


def load_data():
    try:
        with open(DATA, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'chats': {}, 'messages': [], 'syncedAt': None, 'me': None}


def save_data(d):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, DATA)


async def main(mode):
    api_id, api_hash = load_config()
    if not api_id:
        out({'ok': False, 'error': 'Нет tg/config.json с api_id и api_hash', 'configured': False})
        return
    from telethon import TelegramClient
    from telethon.tl.types import User, Chat, Channel

    client = TelegramClient(SESSION, api_id, api_hash)
    if mode == 'login':
        await client.start()          # спросит номер, код и пароль двухэтапной защиты прямо в Терминале
        me = await client.get_me()
        out({'ok': True, 'me': f'{me.first_name or ""} {me.last_name or ""}'.strip()})
        await client.disconnect()
        return

    await client.connect()
    if not await client.is_user_authorized():
        out({'ok': False, 'error': 'Вход в Telegram не выполнен: запустите tg/login.command', 'configured': True, 'authorized': False})
        await client.disconnect()
        return
    if mode == 'status':
        me = await client.get_me()
        out({'ok': True, 'configured': True, 'authorized': True, 'me': f'{me.first_name or ""} {me.last_name or ""}'.strip()})
        await client.disconnect()
        return

    me = await client.get_me()
    data = load_data()
    data['me'] = {'id': me.id, 'name': f'{me.first_name or ""} {me.last_name or ""}'.strip()}
    now = datetime.now(timezone.utc)
    first_edge = now - timedelta(days=FIRST_DAYS)
    keep_edge = now - timedelta(days=KEEP_DAYS)
    known = {(m['chat'], m['id']) for m in data['messages']}
    last_id = {}
    for m in data['messages']:
        last_id[m['chat']] = max(last_id.get(m['chat'], 0), m['id'])

    added = 0
    chats_seen = 0
    async for dlg in client.iter_dialogs(limit=MAX_CHATS):
        ent = dlg.entity
        if isinstance(ent, User):
            if ent.bot or ent.deleted or ent.is_self:
                continue
            kind = 'user'
            name = f'{ent.first_name or ""} {ent.last_name or ""}'.strip() or ent.username or str(ent.id)
        elif isinstance(ent, Chat):
            kind = 'group'
            name = ent.title
        elif isinstance(ent, Channel):
            if not ent.megagroup:
                continue               # каналы-рассылки — это «Сигналы», не переписка
            kind = 'group'
            name = ent.title
        else:
            continue
        if dlg.date and dlg.date < keep_edge:
            continue                   # давно молчащий чат
        cid = str(dlg.id)
        chats_seen += 1
        chat = data['chats'].get(cid, {})
        chat.update({'id': cid, 'name': name, 'kind': kind, 'unread': dlg.unread_count or 0,
                     'lastAt': dlg.date.isoformat() if dlg.date else None})
        data['chats'][cid] = chat
        min_id = last_id.get(cid, 0)
        try:
            async for msg in client.iter_messages(ent, limit=MAX_PER_CHAT, min_id=min_id):
                if not msg.date or msg.date < first_edge and not min_id:
                    break
                text = msg.message or ''
                if not text:
                    if msg.media:
                        text = '[вложение]'
                    else:
                        continue
                sender_name = ''
                is_me = bool(msg.out)
                if not is_me:
                    try:
                        s = await msg.get_sender()
                        if s is not None:
                            sender_name = (f'{getattr(s, "first_name", "") or ""} {getattr(s, "last_name", "") or ""}'.strip()
                                           or getattr(s, 'title', '') or getattr(s, 'username', '') or '')
                    except Exception:
                        sender_name = ''
                key = (cid, msg.id)
                if key in known:
                    continue
                known.add(key)
                data['messages'].append({
                    'id': msg.id, 'chat': cid, 'me': is_me, 'from': sender_name if not is_me else data['me']['name'],
                    'text': text[:2000], 'date': msg.date.isoformat(),
                    'replyTo': msg.reply_to_msg_id if msg.reply_to else None,
                })
                added += 1
        except Exception as e:  # один проблемный чат не должен ломать весь сбор
            chat['error'] = e.__class__.__name__

    # Чистка: старые сообщения и чаты, которых больше нет в списке
    data['messages'] = [m for m in data['messages'] if m['date'] >= keep_edge.isoformat()]
    live = {m['chat'] for m in data['messages']}
    data['chats'] = {k: v for k, v in data['chats'].items() if k in live}
    data['messages'].sort(key=lambda m: m['date'])
    data['syncedAt'] = now.isoformat()
    save_data(data)
    await client.disconnect()
    out({'ok': True, 'added': added, 'chats': len(data['chats']), 'messages': len(data['messages']), 'syncedAt': data['syncedAt']})


if __name__ == '__main__':
    mode = 'collect'
    if '--status' in sys.argv:
        mode = 'status'
    elif '--login' in sys.argv:
        mode = 'login'
    try:
        asyncio.run(main(mode))
    except KeyboardInterrupt:
        pass
    except Exception as e:
        out({'ok': False, 'error': f'{e.__class__.__name__}: {e}'})
