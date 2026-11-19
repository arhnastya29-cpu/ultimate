"""Выжимка данных ULTIMATE для модели: что сегодня, что горит, люди, привычки, самочувствие.
Логика повторяет src/ai.js buildContext, но короче — локальной модели нужен компактный контекст."""
from datetime import datetime, timedelta

WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']


def _d(s):
    return datetime.strptime(s, '%Y-%m-%d').date()


def fmt_date(s, today):
    if not s:
        return ''
    try:
        d = _d(s)
    except Exception:
        return s
    t = _d(today)
    if d == t:
        return 'сегодня'
    if d == t + timedelta(days=1):
        return 'завтра'
    if d == t - timedelta(days=1):
        return 'вчера'
    return f'{d.day:02d}.{d.month:02d} ({WD[d.weekday()]})'


def cut(s, n):
    s = str(s or '').replace('\n', ' ').strip()
    return s if len(s) <= n else s[: n - 1] + '…'


def occurs_on(ev, d):
    if not ev.get('date'):
        return False
    if ev['date'] == d:
        return True
    rep = ev.get('repeat') or 'none'
    if rep == 'none' or d < ev['date']:
        return False
    if ev.get('until') and d > ev['until']:
        return False
    wd = _d(d).weekday()
    if rep == 'daily':
        return True
    if rep == 'weekdays':
        return wd < 5
    if rep == 'weekly':
        return wd == _d(ev['date']).weekday()
    if rep == 'monthly':
        return d[8:] == ev['date'][8:]
    return False


def people_map(state):
    return {p['id']: p for p in state.get('collections', {}).get('people', []) if p.get('id')}


def ceo(state):
    pid = (state.get('settings') or {}).get('ceoPersonId')
    pm = people_map(state)
    if pid and pid in pm:
        return pm[pid]
    for p in pm.values():
        if p.get('type') == 'ceo':
            return p
    return None


def is_mine(t):
    return t.get('direction') != 'theirs'


def day_summary(state, today):
    """Структура для утренней сводки и ответов: события, фокус, просрочка, ожидания, привычки."""
    c = state.get('collections', {})
    tasks = [t for t in c.get('tasks', []) if t.get('id')]
    pm = people_map(state)
    pname = lambda pid: pm.get(pid, {}).get('name', '') if pid else ''
    events = sorted([e for e in c.get('events', []) if occurs_on(e, today)], key=lambda e: e.get('time') or '')
    todays = sorted([t for t in tasks if is_mine(t) and t.get('date') == today and not t.get('done')],
                    key=lambda t: (t.get('priority') or 2, t.get('time') or '99'))
    focus = [t for t in todays if t.get('focusDate') == today] or todays[:3]
    overdue = sorted([t for t in tasks if is_mine(t) and not t.get('done') and t.get('date') and t['date'] < today], key=lambda t: t['date'])
    waiting = [t for t in tasks if not is_mine(t) and not t.get('done')]
    done_today = [t for t in tasks if t.get('done') and str(t.get('doneAt') or '')[:10] == today]
    end = (_d(today) + timedelta(days=7)).strftime('%Y-%m-%d')
    soon = sorted([t for t in tasks if is_mine(t) and not t.get('done') and t.get('date') and today < t['date'] <= end], key=lambda t: t['date'])
    wd = _d(today).weekday()
    habits = [h for h in c.get('habits', []) if not h.get('archived') and (not h.get('days') or wd in h['days'])]
    logs = {(l['habitId'], l['date']): l.get('count', 0) for l in c.get('habitLogs', []) if l.get('habitId')}
    habits_done = [h for h in habits if logs.get((h['id'], today), 0) >= (h.get('target') or 1)]
    sleep = next((s for s in c.get('sleepLogs', []) if s.get('date') == today), None)
    checkin = next((x for x in c.get('checkins', []) if x.get('date') == today), None)
    return dict(events=events, todays=todays, focus=focus, overdue=overdue, waiting=waiting, done_today=done_today,
                soon=soon, habits=habits, habits_done=habits_done, sleep=sleep, checkin=checkin, pname=pname, tasks=tasks)


def build_context(state, today):
    s = day_summary(state, today)
    c = state.get('collections', {})
    settings = state.get('settings') or {}
    pname = s['pname']
    L = [f"Сегодня {today} ({WD[_d(today).weekday()]}). Пользователь: {settings.get('name') or 'имя не указано'}."]

    def tline(t):
        bits = [cut(t.get('title'), 90)]
        if t.get('priority') == 1:
            bits.append('(важно)')
        if t.get('time'):
            bits.append('в ' + t['time'])
        if t.get('date'):
            bits.append('· ' + fmt_date(t['date'], today))
        if t.get('personId'):
            bits.append('· с ' + pname(t['personId']))
        if t.get('source') == 'ceo':
            bits.append('· от CEO')
        return '- ' + ' '.join(bits)

    L.append('\n## Сегодня')
    L.append('События: ' + (', '.join(f"{e.get('time') or 'весь день'} {cut(e.get('title'), 60)}" for e in s['events']) or 'нет'))
    L.append('Фокус дня:\n' + ('\n'.join(tline(t) for t in s['focus']) or '- не выбран'))
    rest = [t for t in s['todays'] if t not in s['focus']]
    if rest:
        L.append('Остальные задачи дня:\n' + '\n'.join(tline(t) for t in rest[:10]))
    if s['done_today']:
        L.append(f"Сделано сегодня: {len(s['done_today'])}")
    if s['overdue']:
        L.append('Просрочено:\n' + '\n'.join(tline(t) for t in s['overdue'][:10]))
    if s['soon']:
        L.append('Ближайшая неделя:\n' + '\n'.join(tline(t) for t in s['soon'][:10]))
    if s['waiting']:
        L.append('Жду от других:\n' + '\n'.join(tline(t) for t in s['waiting'][:8]))
    inbox = [t for t in s['tasks'] if is_mine(t) and not t.get('done') and not t.get('date') and not t.get('timeless')]
    if inbox:
        L.append(f'В инбоксе без даты: {len(inbox)} (например: ' + '; '.join(cut(t.get('title'), 50) for t in inbox[:5]) + ')')

    # цели и проекты
    goals = [g for g in c.get('goals', []) if g.get('status') == 'active']
    if goals:
        L.append('\n## Цели\n' + '\n'.join(f"- {cut(g.get('title'), 80)}{' · до ' + g['deadline'] if g.get('deadline') else ''}" for g in goals[:8]))
    projects = [p for p in c.get('projects', []) if p.get('status') == 'active']
    if projects:
        L.append('\n## Проекты\n' + '\n'.join(f"- {cut(p.get('name'), 60)}{' · следующий шаг: ' + cut(p['nextStep'], 80) if p.get('nextStep') else ''}{' · дедлайн ' + p['deadline'] if p.get('deadline') else ''}" for p in projects[:8]))

    # CEO / Shadow
    boss = ceo(state)
    if boss:
        notes = [n for n in c.get('notes', []) if n.get('personId') == boss['id']]
        rec = [n for n in notes if n.get('type') == 'recommendation']
        meet = sorted([n for n in notes if n.get('type') == 'meeting'], key=lambda n: n.get('date') or '', reverse=True)
        L.append(f"\n## CEO ({boss.get('name')})")
        if boss.get('notes'):
            L.append('Как с ним работать: ' + cut(boss['notes'], 300))
        if rec:
            L.append('Его рекомендации:\n' + '\n'.join(f"- {cut(n.get('title'), 80)}{': ' + cut(n['body'], 140) if n.get('body') else ''}" for n in rec[:8]))
        if meet:
            L.append('Последние встречи:\n' + '\n'.join(f"- {fmt_date(n.get('date'), today)}: {cut(n.get('title'), 80)}{' → ' + cut(n['next'], 80) if n.get('next') else ''}" for n in meet[:4]))

    # привычки и самочувствие
    if s['habits']:
        L.append('\n## Привычки сегодня: ' + ', '.join(f"{h.get('name')} {'✓' if h in s['habits_done'] else '—'}" for h in s['habits']))
    sleeps = sorted([x for x in c.get('sleepLogs', []) if x.get('date')], key=lambda x: x['date'])[-7:]
    checks = sorted([x for x in c.get('checkins', []) if x.get('date')], key=lambda x: x['date'])[-7:]
    if sleeps or checks:
        L.append('\n## Самочувствие за неделю')
        if sleeps:
            L.append('Сон: ' + ', '.join(f"{fmt_date(x['date'], today)} {x.get('hours')} ч" for x in sleeps))
        if checks:
            L.append('Энергия/настроение: ' + ', '.join(f"{fmt_date(x['date'], today)} {x.get('energy') or '-'}/{x.get('mood') or '-'}" for x in checks))
    journal = sorted([j for j in c.get('journal', []) if j.get('date')], key=lambda j: j['date'])[-3:]
    if journal:
        L.append('\n## Последние записи дневника\n' + '\n'.join(f"- {fmt_date(j['date'], today)}: {cut(j.get('highlight') or j.get('wentWell') or '', 120)}" for j in journal))
    return '\n'.join(L)


def morning_digest(state, today):
    """Готовый текст утренней сводки без модели."""
    s = day_summary(state, today)
    pname = s['pname']
    lines = [f"Доброе утро. {WD[_d(today).weekday()].capitalize()}, {_d(today).day:02d}.{_d(today).month:02d}."]
    if s['events']:
        lines.append('\nСобытия:')
        lines += [f"  {e.get('time') or '—'}  {e.get('title')}" + (f" · {pname(e['personId'])}" if e.get('personId') else '') for e in s['events']]
    lines.append('\nФокус дня:' if s['focus'] else '\nЗадач на сегодня нет.')
    lines += [f"  • {t.get('title')}" + (' (важно)' if t.get('priority') == 1 else '') for t in s['focus']]
    rest = len(s['todays']) - len(s['focus'])
    if rest > 0:
        lines.append(f'  ещё {rest} на сегодня')
    if s['overdue']:
        lines.append(f"\nПросрочено: {len(s['overdue'])}")
        lines += [f"  • {t.get('title')} · {fmt_date(t['date'], today)}" for t in s['overdue'][:5]]
    if s['waiting']:
        due = [t for t in s['waiting'] if t.get('date') and t['date'] <= today]
        if due:
            lines.append('\nЖду от других (срок подошёл):')
            lines += [f"  • {t.get('title')} · {pname(t.get('personId'))}" for t in due[:5]]
    if s['habits']:
        lines.append(f"\nПривычки: {len(s['habits_done'])}/{len(s['habits'])}")
    return '\n'.join(lines)
