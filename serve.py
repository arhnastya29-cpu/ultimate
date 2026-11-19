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
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BYTES = 3 * 1024 * 1024
UA = 'Mozilla/5.0 (Macintosh) ULTIMATE-Signals/1.0 (personal RSS reader)'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):  # тише в консоли
        pass

    def end_headers(self):
        # Файлы приложения всегда свежие: кэшем управляет service worker, а не браузер.
        self.send_header('Cache-Control', 'no-store')
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
        return super().do_GET()

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
