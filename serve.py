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
import time
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
        if path.path.startswith('/__whoop/'):
            return self._whoop(path.path[len('/__whoop/'):].split('/')[0], urllib.parse.parse_qs(path.query))
        return super().do_GET()

    # ---- WHOOP: вход через OAuth и сбор сна/восстановления/нагрузки. Ключи и токены — в whoop/ (не в репозитории) ----
    def _whoop(self, action, q):
        w = Whoop(os.path.join(ROOT, 'whoop'))
        if action == 'status':
            return self._json(200, w.status())
        if action == 'connect':
            if not w.configured():
                return self._json(200, {'ok': False, 'error': 'Нет whoop/config.json с client_id и client_secret'})
            self.send_response(302)
            self.send_header('Location', w.auth_url())
            self.end_headers()
            return None
        if action == 'callback':
            code = q.get('code', [''])[0]
            state = q.get('state', [''])[0]
            err = q.get('error', [''])[0]
            try:
                if err:
                    raise RuntimeError(q.get('error_description', [err])[0])
                w.exchange(code, state)
                result = w.sync(days=30)
                msg = 'ok'
            except Exception as e:
                msg = 'err:' + str(e)[:200]
                result = None
            self.send_response(302)
            self.send_header('Location', '/#/settings?whoop=' + urllib.parse.quote(msg))
            self.end_headers()
            return None
        if action == 'sync':
            if not w.connected():
                return self._json(200, {'ok': False, 'error': 'WHOOP не подключён'})
            try:
                days = int(q.get('days', ['7'])[0])
                return self._json(200, w.sync(days=max(1, min(days, 90))))
            except Exception as e:
                return self._json(200, {'ok': False, 'error': f'{e.__class__.__name__}: {e}'[:300]})
        if action == 'data':
            return self._json(200, w.load_data())
        if action == 'disconnect':
            w.disconnect()
            return self._json(200, {'ok': True})
        return self._json(404, {'error': 'нет такого действия'})

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

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path)
        if path.path == '/__whoop/config':
            # Ключи приложения WHOOP из формы в Настройках: сохраняются только в whoop/config.json на этом Mac
            try:
                n = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
                cid = str(body.get('client_id', '')).strip()
                sec = str(body.get('client_secret', '')).strip()
                if not cid or not sec:
                    return self._json(400, {'ok': False, 'error': 'Нужны оба ключа: Client ID и Client Secret'})
                w = Whoop(os.path.join(ROOT, 'whoop'))
                w._write(w.cfg_file, {'client_id': cid, 'client_secret': sec})
                return self._json(200, {'ok': True})
            except Exception as e:
                return self._json(400, {'ok': False, 'error': str(e)[:200]})
        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

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


class Whoop:
    """Вход через WHOOP (OAuth 2.0) и сбор данных API v2. Всё хранится в папке whoop/: config.json
    (client_id, client_secret — вводит пользователь), tokens.json (вход), data.json (собранные данные)."""
    AUTH = 'https://api.prod.whoop.com/oauth/oauth2/auth'
    TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token'
    API = 'https://api.prod.whoop.com/developer'
    SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement'

    def __init__(self, folder):
        self.dir = folder
        self.cfg_file = os.path.join(folder, 'config.json')
        self.tok_file = os.path.join(folder, 'tokens.json')
        self.data_file = os.path.join(folder, 'data.json')
        self.state_file = os.path.join(folder, 'state.txt')

    def _read(self, f, default):
        try:
            with open(f, encoding='utf-8') as h:
                return json.load(h)
        except Exception:
            return default

    def _write(self, f, obj):
        os.makedirs(self.dir, exist_ok=True)
        tmp = f + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as h:
            json.dump(obj, h, ensure_ascii=False)
        os.replace(tmp, f)

    def config(self):
        c = self._read(self.cfg_file, {})
        return (str(c.get('client_id', '')).strip(), str(c.get('client_secret', '')).strip())

    def configured(self):
        cid, sec = self.config()
        return bool(cid and sec)

    def connected(self):
        return bool(self._read(self.tok_file, {}).get('refresh_token'))

    def redirect_uri(self):
        return f'http://127.0.0.1:{PORT}/__whoop/callback'

    def status(self):
        d = self._read(self.data_file, {})
        return {'ok': True, 'configured': self.configured(), 'connected': self.connected(), 'redirectUri': self.redirect_uri(),
                'lastSync': d.get('syncedAt'), 'days': len(d.get('days', {})), 'workouts': len(d.get('workouts', [])), 'profile': d.get('profile')}

    def auth_url(self):
        import secrets
        state = secrets.token_hex(4)          # ровно 8 символов, как требует WHOOP
        os.makedirs(self.dir, exist_ok=True)
        with open(self.state_file, 'w') as h:
            h.write(state)
        cid, _ = self.config()
        q = urllib.parse.urlencode({'client_id': cid, 'redirect_uri': self.redirect_uri(), 'response_type': 'code', 'scope': self.SCOPES, 'state': state})
        return f'{self.AUTH}?{q}'

    def _token_request(self, fields):
        body = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(self.TOKEN, data=body, headers={'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                tok = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'WHOOP отклонил запрос ({e.code}): {e.read().decode("utf-8", "ignore")[:200]}')
        tok['obtained_at'] = time.time()
        self._write(self.tok_file, tok)
        return tok

    def exchange(self, code, state):
        try:
            with open(self.state_file) as h:
                expected = h.read().strip()
        except Exception:
            expected = ''
        if not code or not state or state != expected:
            raise RuntimeError('Неверный ответ от WHOOP (state не совпал). Попробуйте подключить ещё раз.')
        cid, sec = self.config()
        return self._token_request({'grant_type': 'authorization_code', 'code': code, 'client_id': cid, 'client_secret': sec, 'redirect_uri': self.redirect_uri()})

    def access_token(self):
        tok = self._read(self.tok_file, {})
        if not tok.get('refresh_token'):
            raise RuntimeError('WHOOP не подключён')
        if time.time() - float(tok.get('obtained_at', 0)) > float(tok.get('expires_in', 3600)) - 120:
            cid, sec = self.config()
            tok = self._token_request({'grant_type': 'refresh_token', 'refresh_token': tok['refresh_token'], 'client_id': cid, 'client_secret': sec, 'scope': 'offline'})
        return tok['access_token']

    def disconnect(self):
        for f in (self.tok_file, self.state_file):
            try:
                os.remove(f)
            except Exception:
                pass

    def _get(self, path, params=None):
        url = f'{self.API}{path}' + (('?' + urllib.parse.urlencode(params)) if params else '')
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self.access_token(), 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise RuntimeError('WHOOP: слишком много запросов, подождите минуту')
            raise RuntimeError(f'WHOOP ответил {e.code} на {path}')

    def _collection(self, path, start):
        out, token = [], None
        for _ in range(40):                     # не больше 1000 записей за раз
            params = {'limit': 25, 'start': start}
            if token:
                params['nextToken'] = token
            page = self._get(path, params)
            out.extend(page.get('records', []))
            token = page.get('next_token')
            if not token:
                break
        return out

    def load_data(self):
        return self._read(self.data_file, {'days': {}, 'workouts': [], 'profile': None, 'body': None, 'syncedAt': None})

    @staticmethod
    def _local_date(iso, offset):
        """Дата в часовом поясе записи: iso — время в UTC, offset — '+03:00' / 'Z'."""
        from datetime import datetime, timedelta, timezone
        t = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        if offset and offset != 'Z':
            sign = 1 if offset[0] == '+' else -1
            hh, mm = offset[1:].split(':')
            t = t.astimezone(timezone(sign * timedelta(hours=int(hh), minutes=int(mm))))
        return t.strftime('%Y-%m-%d'), t.strftime('%H:%M')

    def sync(self, days=7):
        from datetime import datetime, timedelta, timezone
        start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        data = self.load_data()
        daysd = data.setdefault('days', {})
        sleeps = self._collection('/v2/activity/sleep', start)
        recov = self._collection('/v2/recovery', start)
        cycles = self._collection('/v2/cycle', start)
        workouts = self._collection('/v2/activity/workout', start)
        by_sleep_id = {}
        for s in sleeps:
            if s.get('nap') or s.get('score_state') != 'SCORED' or not s.get('end'):
                continue
            sc = s.get('score') or {}
            st = sc.get('stage_summary') or {}
            date, wake = self._local_date(s['end'], s.get('timezone_offset'))
            _, bed = self._local_date(s['start'], s.get('timezone_offset'))
            asleep_ms = (st.get('total_in_bed_time_milli') or 0) - (st.get('total_awake_time_milli') or 0)
            rec = daysd.setdefault(date, {'date': date})
            rec.update({
                'sleepId': s.get('id'), 'cycleId': s.get('cycle_id'), 'bedTime': bed, 'wakeTime': wake,
                'hours': round(asleep_ms / 3600000, 2), 'inBedHours': round((st.get('total_in_bed_time_milli') or 0) / 3600000, 2),
                'remMin': round((st.get('total_rem_sleep_time_milli') or 0) / 60000), 'deepMin': round((st.get('total_slow_wave_sleep_time_milli') or 0) / 60000),
                'lightMin': round((st.get('total_light_sleep_time_milli') or 0) / 60000), 'awakeMin': round((st.get('total_awake_time_milli') or 0) / 60000),
                'disturbances': st.get('disturbance_count'), 'sleepCycles': st.get('sleep_cycle_count'),
                'performance': sc.get('sleep_performance_percentage'), 'efficiency': sc.get('sleep_efficiency_percentage'),
                'consistency': sc.get('sleep_consistency_percentage'), 'respiratoryRate': sc.get('respiratory_rate'),
                'sleepNeededHours': round(sum((sc.get('sleep_needed') or {}).get(k) or 0 for k in ('baseline_milli', 'need_from_sleep_debt_milli', 'need_from_recent_strain_milli', 'need_from_recent_nap_milli')) / 3600000, 2),
            })
            by_sleep_id[s.get('id')] = date
        for r in recov:
            if r.get('score_state') != 'SCORED':
                continue
            date = by_sleep_id.get(r.get('sleep_id'))
            if not date:
                continue
            sc = r.get('score') or {}
            daysd.setdefault(date, {'date': date}).update({
                'recovery': sc.get('recovery_score'), 'hrv': sc.get('hrv_rmssd_milli'), 'rhr': sc.get('resting_heart_rate'),
                'spo2': sc.get('spo2_percentage'), 'skinTemp': sc.get('skin_temp_celsius'), 'calibrating': sc.get('user_calibrating'),
            })
        for c in cycles:
            if c.get('score_state') != 'SCORED' or not c.get('start'):
                continue
            date, _ = self._local_date(c['start'], c.get('timezone_offset'))
            sc = c.get('score') or {}
            daysd.setdefault(date, {'date': date}).update({
                'strain': sc.get('strain'), 'kcal': round((sc.get('kilojoule') or 0) / 4.184), 'avgHr': sc.get('average_heart_rate'),
                'maxHr': sc.get('max_heart_rate'), 'steps': c.get('step_count'),
            })
        known = {w['id'] for w in data.get('workouts', [])}
        for w in workouts:
            if w.get('score_state') != 'SCORED' or w.get('id') in known or not w.get('start') or not w.get('end'):
                continue
            sc = w.get('score') or {}
            date, t0 = self._local_date(w['start'], w.get('timezone_offset'))
            dur = (datetime.fromisoformat(w['end'].replace('Z', '+00:00')) - datetime.fromisoformat(w['start'].replace('Z', '+00:00'))).total_seconds() / 60
            data.setdefault('workouts', []).append({
                'id': w['id'], 'date': date, 'time': t0, 'sport': w.get('sport_name') or 'Тренировка', 'durationMin': round(dur),
                'strain': sc.get('strain'), 'avgHr': sc.get('average_heart_rate'), 'maxHr': sc.get('max_heart_rate'),
                'kcal': round((sc.get('kilojoule') or 0) / 4.184), 'distanceM': sc.get('distance_meter'),
            })
        try:
            data['profile'] = self._get('/v2/user/profile/basic')
            data['body'] = self._get('/v2/user/measurement/body')
        except Exception:
            pass
        # держим 400 дней
        edge = (datetime.now(timezone.utc) - timedelta(days=400)).strftime('%Y-%m-%d')
        data['days'] = {k: v for k, v in daysd.items() if k >= edge}
        data['workouts'] = [w for w in data.get('workouts', []) if w['date'] >= edge]
        data['syncedAt'] = datetime.now(timezone.utc).isoformat()
        self._write(self.data_file, data)
        return {'ok': True, 'days': len(data['days']), 'workouts': len(data['workouts']), 'syncedAt': data['syncedAt']}


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'ULTIMATE: http://127.0.0.1:{PORT}/')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
