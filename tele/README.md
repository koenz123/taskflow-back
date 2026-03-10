# Telephone Bot — Backend (API)

API для Telphin Call Interactive и теста диалога. Отдельно от фронта, можно деплоить на свой хостинг.

## Запуск

```bash
npm install
cp .env.example .env
# Заполнить .env: OPENAI_API_KEY или GIGACHAT_CREDENTIALS, BASE_URL, при необходимости CORS_ORIGIN
npm run dev
```

Порт по умолчанию 3000. Эндпоинты:

- `GET /` — информация об API (health)
- `POST /api/test-dialog` — тест диалога (JSON: `{ "userText": "..." }` → `{ "reply", "elapsedMs" }`)
- `GET|POST /telphin/call-interactive` — вебхук для Telphin

## Деплой

- **Railway / Render / Fly.io:** указать корень как `backend`, команду старта `npm run build && npm start`, переменные из `.env.example`.
- **VPS:** `npm run build && npm start` или через systemd/pm2. Задать `PORT`, `BASE_URL` (публичный URL бэкенда), `CORS_ORIGIN` (URL фронта через запятую или `*`).

Фронт должен обращаться к этому API по `BASE_URL` (или своему домену бэкенда). В фронте в `config.js` задаётся этот URL.
