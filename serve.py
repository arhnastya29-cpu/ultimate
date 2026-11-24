#!/usr/bin/env python3
"""Локальный сервер ULTIMATE.

Отдаёт файлы приложения (как `python3 -m http.server`) и, вдобавок, умеет загружать
чужие страницы и RSS-ленты для раздела «Сигналы»: браузер сам не может читать
другие сайты (правило CORS), а этот сервер — может.

  GET /__ping             -> {"ok": true}
  GET /__fetch/<метка>?url=...  -> тело страницы по адресу (только http/https, до 3 МБ); метка любая, чтобы браузер не кэшировал

Запускается из start.command; слушает только 127.0.0.1, наружу недоступен.
"""
import gzip
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BYTES = 3 * 1024 * 1024
UA = 'Mozilla/5.0 (Macintosh) ULTIMATE-Signals/1.0 (personal RSS reader)'
TG_LOCK = threading.Lock()   # один сбор Telegram за раз


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):  # тише в консоли
        pass

    def end_headers(self):
        # Файлы приложения браузер каждый раз перепроверяет (no-cache), но service worker может класть их в свой кэш
        # (no-store ему это запрещает и ломает установку новой версии).
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _cors(self):
        # Мостом может пользоваться и сайт ULTIMATE (https://…github.io), не только приложение с 127.0.0.1
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'X-Final-Url')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path)
        if path.path == '/__ping':
            return self._json(200, {'ok': True, 'app': 'ultimate'})
        if path.path == '/__fetch' or path.path.startswith('/__fetch/'):
            return self._fetch(urllib.parse.parse_qs(path.query).get('url', [''])[0])
        if path.path.startswith('/__tg/'):
            return self._tg(path.path[len('/__tg/'):].split('/')[0])
        return super().do_GET()

    # ---- Telegram: раздел «Чаты». Сбор делает tg/collect.py, данные лежат в tg/data/messages.json ----
    def _tg(self, action):
        tg_dir = os.path.join(ROOT, 'tg')
        py = os.path.join(tg_dir, '.venv', 'bin', 'python')
        data_file = os.path.join(tg_dir, 'data', 'messages.json')
        if action == 'status':
            info = {'ok': True, 'configured': os.path.exists(os.path.join(tg_dir, 'config.json')),
                    'session': os.path.exists(os.path.join(tg_dir, 'ultimate.session')), 'env': os.path.exists(py),
                    'syncedAt': None, 'chats': 0, 'messages': 0, 'busy': TG_LOCK.locked()}
            try:
                with open(data_file, encoding='utf-8') as f:
                    d = json.load(f)
                info.update({'syncedAt': d.get('syncedAt'), 'chats': len(d.get('chats', {})), 'messages': len(d.get('messages', []))})
            except Exception:
                pass
            return self._json(200, info)
        if action == 'data':
            try:
                with open(data_file, 'rb') as f:
                    raw = f.read()
            except Exception:
                raw = b'{"chats":{},"messages":[],"syncedAt":null}'
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        if action == 'sync':
            if not os.path.exists(py):
                return self._json(200, {'ok': False, 'error': 'Сначала запустите tg/login.command'})
            if not TG_LOCK.acquire(blocking=False):
                return self._json(200, {'ok': False, 'error': 'Сбор уже идёт', 'busy': True})
            try:
                r = subprocess.run([py, os.path.join(tg_dir, 'collect.py')], capture_output=True, text=True, timeout=300, cwd=tg_dir)
                line = (r.stdout.strip().splitlines() or ['{}'])[-1]
                try:
                    return self._json(200, json.loads(line))
                except Exception:
                    return self._json(200, {'ok': False, 'error': (r.stderr.strip().splitlines() or [line or 'нет ответа'])[-1][:300]})
            except subprocess.TimeoutExpired:
                return self._json(200, {'ok': False, 'error': 'Сбор занял больше 5 минут и был остановлен'})
            finally:
                TG_LOCK.release()
        return self._json(404, {'error': 'нет такого действия'})

    def _fetch(self, url):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.netloc:
            return self._json(400, {'error': 'Нужен адрес, начинающийся с http:// или https://'})
        req = urllib.request.Request(url, headers={
            'User-Agent': UA,
            'Accept': 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/html, application/xml;q=0.9, */*;q=0.8',
            'Accept-Language': 'ru,en;q=0.8',
            'Accept-Encoding': 'gzip',
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read(MAX_BYTES + 1)
                if r.headers.get('Content-Encoding', '').lower() == 'gzip':
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
                ctype = r.headers.get('Content-Type', 'application/octet-stream')
                final = r.geturl()
        except urllib.error.HTTPError as e:
            return self._json(502, {'error': f'Сайт ответил ошибкой {e.code}'})
        except Exception as e:
            return self._json(502, {'error': f'Не удалось загрузить: {e.__class__.__name__}'})
        if len(raw) > MAX_BYTES:
            raw = raw[:MAX_BYTES]
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('X-Final-Url', final)
        self.end_headers()
        self.wfile.write(raw)


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'ULTIMATE: http://127.0.0.1:{PORT}/')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
