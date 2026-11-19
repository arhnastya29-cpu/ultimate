"""ULTIMATE Telegram-бот на локальной модели.

Умеет: отвечать на вопросы по вашим данным, присылать утреннюю сводку, записывать задачи/сон/воду/
заметки по сообщению, вечером спрашивать, как прошёл день, и сохранять ответ в рефлексию.
Запуск: bot/.venv/bin/python bot/ultimate_bot.py   (настройка: bot/.venv/bin/python bot/setup.py)
"""
import json, os, re, sys, time, traceback
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault as V
import context as C
import llm
from tg import Telegram

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'config.json')
STATE = os.path.join(HERE, 'state.json')
WD = {'пн': 0, 'вт': 1, 'ср': 2, 'чт': 3, 'пт': 4, 'сб': 5, 'вс': 6, 'понедельник': 0, 'вторник': 1, 'среду': 2, 'среда': 2,
      'четверг': 3, 'пятницу': 4, 'пятница': 4, 'субботу': 5, 'суббота': 5, 'воскресенье': 6}

HELP = (
    'Я помощник ULTIMATE. Пишите обычным текстом.\n\n'
    'Записать:\n'
    '  задача: отчёт для CEO завтра\n'
    '  ! важная задача в пятницу\n'
    '  сделала: отчёт  (закрыть задачу)\n'
    '  спала 7.5   ·   выпила 500   ·   шаги 8000\n'
    '  энергия 4   ·   настроение 3   ·   вес 61.5\n'
    '  заметка: …   ·   идея: …   ·   ceo: …  (рекомендация)\n'
    '  встреча с CEO завтра 11:00\n'
    '  привычка чтение  (отметить)\n\n'
    'Спросить: что сегодня главное? как подготовиться к встрече с CEO? что я упускаю?\n\n'
    'Команды: /today — сводка, /evening — вопрос о дне, /help'
)


def log(*a):
    print(datetime.now().strftime('%H:%M:%S'), *a, flush=True)


def load_json(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(p, data):
    with open(p, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(p, 0o600)


# ---------- разбор дат и чисел ----------
def parse_date(text, base):
    t = text
    date = None
    def rep(pat, d):
        nonlocal t, date
        m = re.search(pat, t, re.I)
        if m and date is None:
            date = d
            t = (t[:m.start()] + ' ' + t[m.end():])
    rep(r'(^|\s)послезавтра(?=\s|$)', base + timedelta(days=2))
    rep(r'(^|\s)завтра(?=\s|$)', base + timedelta(days=1))
    rep(r'(^|\s)сегодня(?=\s|$)', base)
    m = re.search(r'(^|\s)(?:в|во)\s+(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?=\s|$)', t, re.I)
    if m and date is None:
        want = WD[m.group(2).lower()]
        diff = (want - base.weekday()) % 7 or 7
        date = base + timedelta(days=diff)
        t = t[:m.start()] + ' ' + t[m.end():]
    m = re.search(r'(^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s|$)', t)
    if m and date is None:
        y = base.year if not m.group(4) else int(m.group(4) if len(m.group(4)) == 4 else '20' + m.group(4))
        try:
            date = base.replace(year=y, month=int(m.group(3)), day=int(m.group(2)))
            t = t[:m.start()] + ' ' + t[m.end():]
        except ValueError:
            pass
    return re.sub(r'\s{2,}', ' ', t).strip(), (date.strftime('%Y-%m-%d') if date else None)


def parse_time(text):
    m = re.search(r'(^|\s)(?:в\s+)?(\d{1,2})[:.](\d{2})(?=\s|$)', text)
    if not m:
        return text, ''
    hh, mm = int(m.group(2)), int(m.group(3))
    if hh > 23 or mm > 59:
        return text, ''
    t = text[:m.start()] + ' ' + text[m.end():]
    return re.sub(r'\s{2,}', ' ', t).strip(), f'{hh:02d}:{mm:02d}'


def num(text):
    m = re.search(r'(\d+(?:[.,]\d+)?)', text)
    return float(m.group(1).replace(',', '.')) if m else None


# ---------- бот ----------
class Bot:
    def __init__(self):
        self.cfg = load_json(CONFIG, None)
        if not self.cfg:
            sys.exit('Нет bot/config.json — сначала запустите: bot/.venv/bin/python bot/setup.py')
        self.vault = V.Vault(self.cfg['sync_password'])
        self.tg = Telegram(self.cfg['telegram_token'])
        self.model = self.cfg.get('model', 'qwen2.5:14b')
        self.st = load_json(STATE, {'chat_id': self.cfg.get('chat_id'), 'history': [], 'awaiting': None, 'last_morning': '', 'last_evening': ''})
        self._cache = (None, 0)

    # --- данные ---
    def state(self, max_age=60):
        data, at = self._cache
        if data is None or time.time() - at > max_age:
            data, _ = self.vault.pull()
            if data is None:
                raise V.VaultError('В облаке нет данных: включите синхронизацию в приложении ULTIMATE')
            self._cache = (data, time.time())
        return data

    def write(self, mutate):
        res = self.vault.write(mutate)
        self._cache = (None, 0)
        return res

    # --- сообщения ---
    def reply(self, text):
        self.tg.send(self.st['chat_id'], text)

    def ask_model(self, text):
        today = V.today()
        ctx = C.build_context(self.state(), today)
        self.tg.typing(self.st['chat_id'])
        answer = llm.chat(self.model, ctx, self.st['history'], text)
        self.st['history'] = (self.st['history'] + [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': answer}])[-10:]
        save_json(STATE, self.st)
        return answer or 'Не получилось сформулировать ответ. Попробуйте переформулировать.'

    def handle(self, text):
        t = text.strip()
        low = t.lower()
        today_s = V.today()
        base = datetime.now().date()

        if low in ('/start', '/help', 'помощь', 'help'):
            return HELP
        if low in ('/today', 'сводка', '/morning'):
            return self.morning(force=True)
        if low in ('/evening', 'вечер'):
            return self.evening(force=True)

        # вечерний ответ
        if self.st.get('awaiting') == 'evening':
            self.st['awaiting'] = None
            save_json(STATE, self.st)
            first, _, rest = t.partition('\n') if '\n' in t else (t.split('. ')[0], '', '. '.join(t.split('. ')[1:]))
            def mut(s):
                j = V.first(s, 'journal', lambda j: j.get('date') == today_s)
                patch = {'highlight': first.strip()[:200], 'wentWell': rest.strip()}
                if j:
                    V.update(s, 'journal', j['id'], patch)
                else:
                    V.add(s, 'journal', dict(date=today_s, gratitude='', lessons='', improve='', mood=None, **patch))
                return 'ok'
            self.write(mut)
            comment = self.ask_model('Я ответила на вечерний вопрос про день: «' + t + '». Коротко откликнись (2–3 строки) и предложи одну мысль на завтра.')
            return 'Записала в рефлексию.\n\n' + comment

        # --- записи ---
        m = re.match(r'^(задача|сделать|todo)\s*[:\-]?\s*(.+)$', t, re.I | re.S)
        if m or t.startswith('!'):
            body = m.group(2) if m else t
            priority = 2
            if body.startswith('!'):
                priority, body = 1, body[1:].strip()
            body, date = parse_date(body, base)
            body, tm = parse_time(body)
            timeless = bool(re.search(r'\sбессрочно$', body, re.I))
            body = re.sub(r'\sбессрочно$', '', body, flags=re.I).strip()
            person = None
            data = self.state()
            boss = C.ceo(data)
            if boss and re.search(r'\b(ceo|сео|для ceo|от ceo)\b', body, re.I):
                person = boss
            def mut(s):
                rec = V.add(s, 'tasks', V.new_task(title=body, date=None if timeless else (date or today_s), time=tm, priority=priority,
                                                   timeless=timeless, personId=person['id'] if person else None,
                                                   source='ceo' if person else 'manual', receivedAt=today_s if person else None))
                return rec
            rec = self.write(mut)
            when = 'бессрочно' if timeless else C.fmt_date(rec['date'], today_s)
            return f"Задача записана: «{body}» · {when}" + (f' в {tm}' if tm else '') + (' · важно' if priority == 1 else '') + (f" · с {person['name']}" if person else '')

        m = re.match(r'^(сделал[аи]?|готово|закрыл[аи]?|выполнил[аи]?)\s*[:\-]?\s*(.+)$', t, re.I)
        if m:
            q = m.group(2).strip().lower()
            data = self.state()
            cands = [x for x in V.col(data, 'tasks') if not x.get('done') and q in str(x.get('title', '')).lower()]
            if not cands:
                return f'Не нашла открытую задачу со словами «{q}».'
            if len(cands) > 1:
                return 'Нашла несколько, уточните:\n' + '\n'.join('• ' + x['title'] for x in cands[:6])
            tid = cands[0]['id']
            self.write(lambda s: V.update(s, 'tasks', tid, {'done': True, 'doneAt': V.now_iso()}))
            return f"Закрыла: «{cands[0]['title']}»"

        m = re.match(r'^(спал[аи]?|сон)\s*[:\-]?\s*(.+)$', t, re.I)
        if m and num(m.group(2)) is not None:
            hours = num(m.group(2))
            def mut(s):
                cur = V.first(s, 'sleepLogs', lambda x: x.get('date') == today_s)
                if cur:
                    V.update(s, 'sleepLogs', cur['id'], {'hours': hours})
                else:
                    V.add(s, 'sleepLogs', dict(date=today_s, bedTime='', wakeTime='', hours=hours, quality=None, notes=''))
            self.write(mut)
            return f'Сон: {hours:g} ч записан.'

        m = re.match(r'^(выпил[аи]?|вода|воды)\s*[:\-]?\s*(.+)$', t, re.I)
        if m and num(m.group(2)) is not None:
            ml = int(num(m.group(2)))
            if ml <= 5:
                ml = int(ml * 1000)
            def mut(s):
                cur = V.first(s, 'dayLogs', lambda x: x.get('date') == today_s)
                if cur:
                    V.update(s, 'dayLogs', cur['id'], {'waterMl': (cur.get('waterMl') or 0) + ml})
                else:
                    V.add(s, 'dayLogs', dict(date=today_s, waterMl=ml, steps=0))
            self.write(mut)
            return f'+{ml} мл воды.'

        m = re.match(r'^(шаги|шагов)\s*[:\-]?\s*(.+)$', t, re.I)
        if m and num(m.group(2)) is not None:
            n = int(num(m.group(2)))
            def mut(s):
                cur = V.first(s, 'dayLogs', lambda x: x.get('date') == today_s)
                if cur:
                    V.update(s, 'dayLogs', cur['id'], {'steps': n})
                else:
                    V.add(s, 'dayLogs', dict(date=today_s, waterMl=0, steps=n))
            self.write(mut)
            return f'Шаги за сегодня: {n}.'

        m = re.match(r'^(энергия|настроение|уверенность|стресс|вес)\s*[:\-]?\s*(.+)$', t, re.I)
        if m and num(m.group(2)) is not None:
            field = {'энергия': 'energy', 'настроение': 'mood', 'уверенность': 'confidence', 'стресс': 'stress', 'вес': 'weight'}[m.group(1).lower()]
            val = num(m.group(2))
            if field != 'weight':
                val = int(max(1, min(5, val)))
            def mut(s):
                cur = V.first(s, 'checkins', lambda x: x.get('date') == today_s)
                if cur:
                    V.update(s, 'checkins', cur['id'], {field: val})
                else:
                    V.add(s, 'checkins', dict(date=today_s, mood=None, energy=None, stress=None, confidence=None, symptoms=[], notes='', **{field: val}))
            self.write(mut)
            return f'{m.group(1).capitalize()}: {val:g} записано.'

        m = re.match(r'^(заметка|идея|ceo|сео|рекомендация|инсайт)\s*[:\-]\s*(.+)$', t, re.I | re.S)
        if m:
            kind = m.group(1).lower()
            body = m.group(2).strip()
            ntype = 'idea' if kind == 'идея' else 'recommendation' if kind in ('ceo', 'сео', 'рекомендация') else 'insight' if kind == 'инсайт' else 'note'
            data = self.state()
            boss = C.ceo(data) if ntype == 'recommendation' else None
            lines = body.split('\n')
            title, text_body = lines[0][:120], ('\n'.join(lines[1:]).strip() if len(lines) > 1 else (body if len(body) > 120 else ''))
            extra = {'status': 'new', 'impact': 2, 'effort': 2} if ntype == 'idea' else {}
            self.write(lambda s: V.add(s, 'notes', V.new_note(type=ntype, title=title, body=text_body, personId=boss['id'] if boss else None, **extra)))
            return {'idea': 'Идея записана.', 'recommendation': 'Рекомендация CEO записана.', 'insight': 'Инсайт записан.', 'note': 'Заметка записана.'}[ntype]

        if re.search(r'^(встреча|созвон|событие|звонок)\b', low) or (re.search(r'\d{1,2}[:.]\d{2}', t) and re.search(r'встреч|созвон|звонок|планёрк|планерк|презентац', low)):
            body, date = parse_date(t, base)
            body, tm = parse_time(body)
            body = re.sub(r'^(событие)\s*[:\-]?\s*', '', body, flags=re.I).strip()
            data = self.state()
            boss = C.ceo(data)
            person = boss if boss and re.search(r'\b(ceo|сео)\b', body, re.I) else None
            self.write(lambda s: V.add(s, 'events', dict(title=body or 'Встреча', date=date or today_s, time=tm, endTime='', place='', kind='meeting',
                                                         personId=person['id'] if person else None, repeat='none', until='', notes='')))
            return f"Событие добавлено: «{body}» · {C.fmt_date(date or today_s, today_s)}" + (f' в {tm}' if tm else '')

        m = re.match(r'^привычка\s*[:\-]?\s*(.+)$', t, re.I)
        if m:
            q = m.group(1).strip().lower()
            data = self.state()
            hs = [h for h in V.col(data, 'habits') if not h.get('archived') and q in str(h.get('name', '')).lower()]
            if not hs:
                return f'Не нашла привычку «{q}».'
            h = hs[0]
            def mut(s):
                cur = V.first(s, 'habitLogs', lambda l: l.get('habitId') == h['id'] and l.get('date') == today_s)
                tg = h.get('target') or 1
                if cur:
                    V.update(s, 'habitLogs', cur['id'], {'count': tg})
                else:
                    V.add(s, 'habitLogs', dict(habitId=h['id'], date=today_s, count=tg))
            self.write(mut)
            return f"Привычка «{h['name']}» отмечена."

        # --- вопрос к модели ---
        return self.ask_model(t)

    # --- расписание ---
    def morning(self, force=False):
        today_s = V.today()
        if not force and self.st.get('last_morning') == today_s:
            return None
        self.st['last_morning'] = today_s
        save_json(STATE, self.st)
        data = self.state(max_age=0)
        text = C.morning_digest(data, today_s)
        try:
            self.tg.typing(self.st['chat_id'])
            advice = llm.chat(self.model, C.build_context(data, today_s), [], 'Дай один короткий совет на сегодня (2–3 строки) по моим данным: с чего начать и что не упустить.')
            if advice:
                text += '\n\nСовет: ' + advice
        except Exception as e:
            log('совет не получен:', e)
        return text

    def evening(self, force=False):
        today_s = V.today()
        if not force and self.st.get('last_evening') == today_s:
            return None
        self.st['last_evening'] = today_s
        self.st['awaiting'] = 'evening'
        save_json(STATE, self.st)
        data = self.state(max_age=0)
        s = C.day_summary(data, today_s)
        done = len(s['done_today'])
        return (f"Как прошёл день? Сделано задач: {done}, привычки {len(s['habits_done'])}/{len(s['habits'])}.\n"
                'Напишите главное событие дня и что получилось — сохраню в рефлексию. Или «пропустить».')

    def tick(self):
        if not self.st.get('chat_id'):
            return
        now = datetime.now()
        mh, eh = int(self.cfg.get('morning_hour', 8)), int(self.cfg.get('evening_hour', 21))
        if now.hour >= mh and self.st.get('last_morning') != V.today():
            try:
                msg = self.morning()
                if msg:
                    self.reply(msg)
            except Exception as e:
                log('утро:', e)
        if now.hour >= eh and self.st.get('last_evening') != V.today():
            try:
                msg = self.evening()
                if msg:
                    self.reply(msg)
            except Exception as e:
                log('вечер:', e)

    # --- главный цикл ---
    def run(self):
        me = self.tg.me()
        log(f"бот @{me.get('username')} запущен, модель {self.model}")
        ok, names = llm.available(self.model)
        if not ok:
            log('внимание: модель не найдена в Ollama; есть:', names)
        while True:
            try:
                for u in self.tg.updates():
                    msg = u.get('message') or {}
                    text = msg.get('text') or ''
                    chat_id = msg.get('chat', {}).get('id')
                    if not text or not chat_id:
                        continue
                    # привязка: первое сообщение с кодом из setup
                    if not self.st.get('chat_id'):
                        if text.strip() == f"/start {self.cfg.get('pair_code')}" or text.strip() == self.cfg.get('pair_code'):
                            self.st['chat_id'] = chat_id
                            save_json(STATE, self.st)
                            self.tg.send(chat_id, 'Готово, это ваш чат. ' + HELP)
                        else:
                            self.tg.send(chat_id, 'Отправьте код привязки из настройки (bot/setup.py).')
                        continue
                    if chat_id != self.st['chat_id']:
                        continue                      # чужие чаты игнорируем
                    if text.strip().lower() in ('пропустить', 'skip') and self.st.get('awaiting'):
                        self.st['awaiting'] = None
                        save_json(STATE, self.st)
                        self.reply('Хорошо, пропускаем.')
                        continue
                    try:
                        answer = self.handle(text)
                        if answer:
                            self.reply(answer)
                    except V.VaultError as e:
                        self.reply('Данные: ' + str(e))
                    except Exception as e:
                        log('ошибка:', traceback.format_exc())
                        self.reply('Не получилось: ' + str(e)[:200])
                self.tick()
            except KeyboardInterrupt:
                break
            except Exception as e:
                log('цикл:', e)
                time.sleep(5)


if __name__ == '__main__':
    Bot().run()
