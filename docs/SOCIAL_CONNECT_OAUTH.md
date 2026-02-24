# Настройка OAuth для «Подключить соцсеть»

Чтобы кнопка «Подключить» вела на сайт соцсети (а не на `?error=not_configured`), нужно создать приложение у провайдера и задать переменные окружения на бэкенде.

**Общее:** URL callback'а бэкенда для каждой платформы такой (подставьте свой домен API):

```
{PUBLIC_BASE_URL}/api/auth/connect/{platform}/callback
```

Примеры:
- `https://api.example.com/api/auth/connect/vk/callback`
- `https://api.example.com/api/auth/connect/instagram/callback`
- `https://api.example.com/api/auth/connect/youtube/callback`
- `https://api.example.com/api/auth/connect/tiktok/callback`

`PUBLIC_BASE_URL` (или `API_BASE_URL`) — тот URL, по которому доступен ваш бэкенд (без завершающего слэша). Этот же URL должен быть указан в настройках приложения у провайдера как **Redirect URI** / **Authorized redirect URI**.

---

## 1. VK

- **Где взять:** [dev.vk.com](https://dev.vk.com) → Мои приложения → Создать → Standalone-приложение. В настройх указать **Redirect URI**: `https://ваш-домен/api/auth/connect/vk/callback`.
- **Переменные окружения:**

| Переменная           | Обязательно | Описание                          |
|----------------------|-------------|-----------------------------------|
| `VK_CLIENT_ID`       | да          | ID приложения (цифры)             |
| `VK_CLIENT_SECRET`   | да          | Защищённый ключ                   |
| `VK_CONNECT_SCOPE`   | нет         | Права (по умолчанию `offline`)   |
| `VK_API_VERSION`     | нет         | Версия API (по умолчанию `5.199`)|

---

## 2. Instagram

- **Где взять:** [developers.facebook.com](https://developers.facebook.com) → Создать приложение → Добавить продукт **Instagram** (Instagram Graph API или Instagram Basic Display; Basic Display [сворачивается](https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/), предпочтительно Instagram Login / Graph). В настройках OAuth указать **Valid OAuth Redirect URIs**: `https://ваш-домен/api/auth/connect/instagram/callback`.
- **Переменные окружения:**

| Переменная                 | Обязательно | Описание        |
|----------------------------|-------------|-----------------|
| `INSTAGRAM_CLIENT_ID`      | да          | App ID / Client ID |
| `INSTAGRAM_CLIENT_SECRET`  | да          | App Secret      |

В коде используются scope: `user_profile`, `user_media`. Если у вас другой продукт (Graph API), может понадобиться правка scope в `server/integrations/socialConnect.js`.

---

## 3. YouTube (Google)

- **Где взять:** [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth 2.0 Client ID (тип «Web application»). В **Authorized redirect URIs** добавить: `https://ваш-домен/api/auth/connect/youtube/callback`. Включить API: YouTube Data API v3.
- **Переменные окружения:**

| Переменная                     | Обязательно | Описание                          |
|--------------------------------|-------------|-----------------------------------|
| `GOOGLE_WEB_CLIENT_ID`         | да*         | OAuth 2.0 Client ID               |
| `GOOGLE_WEB_CLIENT_SECRET`     | да*         | OAuth 2.0 Client Secret           |
| `YOUTUBE_CLIENT_ID`            | нет         | Альтернатива к GOOGLE_WEB_CLIENT_ID   |
| `YOUTUBE_CLIENT_SECRET`        | нет         | Альтернатива к GOOGLE_WEB_CLIENT_SECRET |

\* Можно использовать те же учётные данные, что и для входа через Google в приложении (`GOOGLE_WEB_CLIENT_ID` / `GOOGLE_WEB_CLIENT_SECRET`).

---

## 4. TikTok

- **Где взять:** [TikTok for Developers](https://developers.tiktok.com) → Login Kit. Создать приложение, в настройках указать **Redirect URI**: `https://ваш-домен/api/auth/connect/tiktok/callback`.
- **Переменные окружения:**

| Переменная               | Обязательно | Описание                    |
|--------------------------|-------------|-----------------------------|
| `TIKTOK_CLIENT_KEY`      | да*         | Client Key приложения       |
| `TIKTOK_CLIENT_ID`       | нет         | Альтернатива к CLIENT_KEY  |
| `TIKTOK_CLIENT_SECRET`   | да          | Client Secret               |

---

## 5. Telegram

В текущей реализации **нет** классического OAuth redirect (как у VK/Google). Вход через Telegram уже есть в приложении (виджет «Login with Telegram»). Для кнопки «Подключить» в профиле нужен отдельный сценарий (например, deep link в бота или отдельная страница с виджетом). Сейчас при нажатии «Подключить» для Telegram будет `not_configured` — это ожидаемо до реализации отдельного флоу.

---

## 6. WhatsApp

Нет стандартного «подключить профиль» через OAuth, как у соцсетей. WhatsApp Business API предполагает другой сценарий (номер, верификация и т.д.). Сейчас при выборе WhatsApp будет `not_configured` — при необходимости можно добавить свой флоу позже.

---

## Чек-лист по платформе

1. Создать приложение у провайдера (VK / Meta / Google / TikTok).
2. Указать **Redirect URI** в точности: `https://ваш-бэкенд-домен/api/auth/connect/<platform>/callback` (без слэша в конце, протокол и домен как у реального API).
3. Задать переменные окружения на сервере (см. таблицы выше).
4. Убедиться, что на бэкенде заданы:
   - `PUBLIC_BASE_URL` или `API_BASE_URL` — публичный URL бэкенда (используется как `redirect_uri` при обмене code на токен).
   - `JWT_SECRET` — уже должен быть для авторизации.
5. Перезапустить бэкенд и снова нажать «Подключить» для выбранной платформы.

После этого запрос на `GET /api/auth/connect/<platform>` будет отдавать редирект на страницу авторизации выбранной соцсети (или JSON с `redirectUrl` при запросе с `?json=1` / `Accept: application/json`).
