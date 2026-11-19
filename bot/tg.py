"""Минимальный клиент Telegram Bot API без внешних библиотек (long polling)."""
import json, urllib.parse, urllib.request


class Telegram:
    def __init__(self, token):
        self.base = f'https://api.telegram.org/bot{token}'
        self.offset = None

    def call(self, method, params=None, http_timeout=35):
        data = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None}).encode()
        req = urllib.request.Request(f'{self.base}/{method}', data=data)
        with urllib.request.urlopen(req, timeout=http_timeout) as r:
            out = json.loads(r.read().decode())
        if not out.get('ok'):
            raise RuntimeError(out.get('description', 'telegram error'))
        return out['result']

    def me(self):
        return self.call('getMe', http_timeout=15)

    def updates(self):
        res = self.call('getUpdates', {'offset': self.offset, 'timeout': 30, 'allowed_updates': '["message"]'}, http_timeout=40)
        for u in res:
            self.offset = u['update_id'] + 1
        return res

    def send(self, chat_id, text):
        text = text or '…'
        for i in range(0, len(text), 3900):          # лимит Telegram — 4096 символов
            self.call('sendMessage', {'chat_id': chat_id, 'text': text[i:i + 3900], 'disable_web_page_preview': 'true'}, http_timeout=20)

    def typing(self, chat_id):
        try:
            self.call('sendChatAction', {'chat_id': chat_id, 'action': 'typing'}, http_timeout=10)
        except Exception:
            pass
