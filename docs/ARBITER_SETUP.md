# Вход арбитра на nativki.ru

Чтобы арбитр мог входить на nativki.ru (email + пароль), на бэкенде нужно один раз завести пользователя с ролью `arbiter`.

## Данные для входа

| Поле    | Значение        |
|---------|-----------------|
| Email   | arbiter@taskflow.ru |
| Пароль  | Arbiter2026!    |
| Роль    | arbiter         |

## Как завести пользователя

На сервере должен быть задан **ADMIN_TOKEN** (переменная окружения). Однократно вызовите админ-эндпоинт:

```bash
curl -X POST "https://ваш-бэкенд/api/admin/create-arbiter" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: ВАШ_ADMIN_TOKEN" \
  -d '{"email":"arbiter@taskflow.ru","password":"Arbiter2026!"}'
```

Для локального бэкенда (например, `http://localhost:4000`):

```bash
curl -X POST "http://localhost:4000/api/admin/create-arbiter" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: ВАШ_ADMIN_TOKEN" \
  -d '{"email":"arbiter@taskflow.ru","password":"Arbiter2026!"}'
```

Успешный ответ: `201` или `200` с телом вида `{"ok":true,"userId":"...","email":"arbiter@taskflow.ru","role":"arbiter"}`.

После этого арбитр может войти на nativki.ru через форму входа (email + пароль) с указанными данными.
