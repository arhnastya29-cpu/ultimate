"""Локальная модель через Ollama (http://127.0.0.1:11434)."""
import json, urllib.request

OLLAMA = 'http://127.0.0.1:11434'

SYSTEM = (
    'Ты — личный помощник в приложении ULTIMATE (персональная система эффективности). '
    'Ниже выжимка реальных данных пользователя на сегодня: задачи, события, цели, проекты, CEO, привычки, самочувствие. '
    'Опирайся только на неё и на то, что пишет пользователь; ничего не выдумывай. Если данных не хватает — скажи, чего именно, и задай один вопрос.\n'
    'Стиль: по-русски, на «ты», коротко и по делу, без лозунгов и восклицаний, как опытный коуч и ассистент. '
    'Отвечай обычным текстом без markdown-разметки (без звёздочек и решёток), максимум 8–10 строк. '
    'Если просят совет — дай 2–3 конкретных шага с привязкой к данным. '
    'Про CEO: помогай готовиться к разговорам, опираясь на его рекомендации и заметки о нём.'
)


def available(model):
    try:
        with urllib.request.urlopen(OLLAMA + '/api/tags', timeout=5) as r:
            tags = json.loads(r.read().decode()).get('models', [])
        names = {m.get('name') for m in tags}
        return any(n == model or n.split(':')[0] == model.split(':')[0] for n in names), sorted(names)
    except Exception:
        return False, []


def chat(model, context, history, user_text, temperature=0.4, timeout=180):
    messages = [{'role': 'system', 'content': SYSTEM + '\n\n# Данные пользователя\n' + context}]
    messages += history[-6:]
    messages.append({'role': 'user', 'content': user_text})
    body = json.dumps({'model': model, 'messages': messages, 'stream': False,
                       'options': {'temperature': temperature, 'num_ctx': 8192}}).encode()
    req = urllib.request.Request(OLLAMA + '/api/chat', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    return (out.get('message') or {}).get('content', '').strip()
