"""Доступ к зашифрованному хранилищу ULTIMATE (Supabase, таблица vaults).

Повторяет src/sync.js: из пароля PBKDF2 (250 000 итераций, SHA-256) выводятся id полки и ключ
AES-GCM; снимок данных сжат gzip и зашифрован; запись защищена номером версии.
Пароль хранится только в bot/config.json на этом Mac (права 600).
"""
import base64, gzip, hashlib, json, os, secrets, time, unicodedata, urllib.parse, urllib.request
from datetime import datetime, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SUPABASE_URL = 'https://alsiycuvfpbcafbqmxbc.supabase.co'
SUPABASE_KEY = 'sb_publishable_Jva5ty_BFTaFAZmcOvouTw_FEa35EiD'
TABLE = 'vaults'
PBKDF2_ITER = 250000

COLLECTIONS = [
    'learningAreas', 'learningItems', 'studySessions', 'flashcards',
    'goals', 'tasks', 'projects', 'streams', 'visionItems',
    'shadowTasks', 'shadowNotes', 'people', 'commitments', 'contacts',
    'kbSections', 'kbPages', 'ideas', 'events',
    'checkins', 'labTests', 'healthTodos', 'medications', 'medLogs',
    'workouts', 'workoutTemplates', 'foods', 'meals', 'dayLogs',
    'habits', 'habitLogs', 'sleepLogs', 'books', 'notes',
    'transactions', 'budgets', 'financeGoals', 'journal', 'weeklyReviews',
]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def today():
    return datetime.now().strftime('%Y-%m-%d')


def uid():
    return format(int(time.time() * 1000), 'x') + secrets.token_hex(3)


class VaultError(Exception):
    pass


class Vault:
    def __init__(self, password: str):
        pw = unicodedata.normalize('NFKC', password).encode('utf-8')
        self.vault_id = hashlib.pbkdf2_hmac('sha256', pw, b'ultimate-sync-id-v1', PBKDF2_ITER, 32).hex()
        self.key = hashlib.pbkdf2_hmac('sha256', pw, b'ultimate-sync-key-v1', PBKDF2_ITER, 32)
        self.aes = AESGCM(self.key)

    # ---------- криптография ----------
    def decrypt(self, blob: str) -> dict:
        parts = str(blob).split('.')
        if len(parts) != 3:
            raise VaultError('Повреждённые данные в облаке')
        tag, iv_b, ct_b = parts
        try:
            plain = self.aes.decrypt(base64.b64decode(iv_b), base64.b64decode(ct_b), None)
        except Exception:
            raise VaultError('Не удалось расшифровать: пароль не совпадает')
        if tag == 'g1':
            plain = gzip.decompress(plain)
        return json.loads(plain.decode('utf-8'))

    def encrypt(self, state: dict) -> str:
        data = gzip.compress(json.dumps(state, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        iv = secrets.token_bytes(12)
        ct = self.aes.encrypt(iv, data, None)
        return 'g1.' + base64.b64encode(iv).decode() + '.' + base64.b64encode(ct).decode()

    # ---------- Supabase ----------
    def _headers(self, extra=None):
        h = {'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json'}
        if extra:
            h.update(extra)
        return h

    def pull_raw(self):
        q = urllib.parse.urlencode({'id': 'eq.' + self.vault_id, 'select': 'blob,version'})
        req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{TABLE}?{q}', headers=self._headers())
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode())
        return rows[0] if rows else None

    def pull(self):
        """Возвращает (state, version). Если полки нет — (None, None)."""
        row = self.pull_raw()
        if not row:
            return None, None
        return self.decrypt(row['blob']), row['version']

    def push(self, state: dict, version: int) -> bool:
        blob = self.encrypt(state)
        body = json.dumps({'blob': blob, 'version': version + 1, 'updated_at': now_iso()}).encode()
        q = urllib.parse.urlencode({'id': 'eq.' + self.vault_id, 'version': 'eq.' + str(version)})
        req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{TABLE}?{q}', data=body, method='PATCH',
                                     headers=self._headers({'Prefer': 'return=representation'}))
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode())
        return len(rows) > 0

    # ---------- запись с проверкой версии ----------
    def write(self, mutate):
        """mutate(state) меняет состояние на месте и возвращает описание результата.
        Повторяет попытку, если приложение успело записать раньше."""
        for _ in range(4):
            state, version = self.pull()
            if state is None:
                raise VaultError('В облаке нет данных: включите синхронизацию в приложении')
            result = mutate(state)
            if self.push(state, version):
                return result
            time.sleep(1.0)
        raise VaultError('Облако занято, попробуйте ещё раз')


# ---------- помощники для записей ----------
def col(state, name):
    return state.setdefault('collections', {}).setdefault(name, [])


def add(state, name, rec: dict):
    t = now_iso()
    rec = {'id': uid(), 'createdAt': t, 'updatedAt': t, **{k: v for k, v in rec.items() if v is not None or k in ('date',)}}
    col(state, name).append(rec)
    return rec


def update(state, name, rec_id, patch: dict):
    for r in col(state, name):
        if r.get('id') == rec_id:
            r.update(patch)
            r['updatedAt'] = now_iso()
            return r
    return None


def find(state, name, pred):
    return [r for r in col(state, name) if pred(r)]


def first(state, name, pred):
    for r in col(state, name):
        if pred(r):
            return r
    return None


def new_task(**patch):
    base = dict(title='', notes='', date=None, time='', priority=2, done=False, doneAt=None, projectId=None,
                streamId=None, goalId=None, personId=None, source='manual', direction='mine', tags=[],
                estimateMin=None, recurring=None, checklist=[], timeless=False)
    base.update(patch)
    return base


def new_note(**patch):
    base = dict(type='note', title='', body='', date=today(), tags=[], personId=None, projectId=None, goalId=None,
                learningItemId=None, pinned=False, quote=False, sourceType='thought', sourceTitle='',
                sourceAuthor='', sourceUrl='')
    base.update(patch)
    return base
