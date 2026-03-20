# Brands API (Backend)

Эндпоинты предназначены для вкладки **“Бренды”** в профиле заказчика и для привязки бренда к заданиям.

## Доступ и авторизация

- Все эндпоинты требуют авторизацию (`requireAuth`).
- Роль: **только `customer`**.
- Владелец бренда: текущий пользователь (проверяем по `ownerUserId` или `ownerMongoId`).

## Модель Brand (MongoDB, коллекция `brands`)

- `id`: string (Mongo `_id` в виде строки)
- `ownerUserId`: string (public id, например `tg_...` или Mongo id)
- `ownerMongoId`: string (Mongo id пользователя)
- `name`: string
- `logoUrl`: string | null (разрешено `https://...` / `http://...` или `/uploads/...`)
- `socials`: object (ключ → строка URL/handle)
- `guidelines`: string | null
- `createdAt`: ISO string
- `updatedAt`: ISO string

## CRUD брендов

### GET `/api/brands`
Список брендов текущего пользователя.

Ответ `200`:

```json
[
  {
    "id": "65f0...",
    "ownerUserId": "tg_123",
    "ownerMongoId": "65ef...",
    "name": "My Brand",
    "logoUrl": "/uploads/logo.png",
    "socials": { "instagram": "https://instagram.com/..." },
    "guidelines": "Some markdown/text",
    "createdAt": "2026-03-17T12:00:00.000Z",
    "updatedAt": "2026-03-17T12:00:00.000Z"
  }
]
```

Ошибки:
- `401` `{ "error": "unauthorized" | "<reason>" }`
- `403` `{ "error": "forbidden" }` (если не customer)

### POST `/api/brands`
Создать бренд.

Body:

```json
{
  "name": "Brand name",
  "logoUrl": "https://... или /uploads/...",
  "socials": { "instagram": "https://...", "tiktok": "https://..." },
  "guidelines": "text"
}
```

Ответ `201`: DTO бренда (как в GET).

Ошибки:
- `400` `{ "error": "invalid_name" }`
- `401`, `403`, `500`

### PATCH `/api/brands/:brandId`
Обновить бренд (только владелец). Частичное обновление.

Body (любые поля из списка):

```json
{
  "name": "New name",
  "logoUrl": null,
  "socials": { "youtube": "https://..." },
  "guidelines": "updated text"
}
```

Ответ `200`: DTO бренда.

Ошибки:
- `400` `{ "error": "bad_brand_id" | "invalid_name" | "invalid_logoUrl" | "invalid_socials" }`
- `403` `{ "error": "forbidden" }` (если не владелец или не customer)
- `404` `{ "error": "not_found" }`

### DELETE `/api/brands/:brandId`
Удалить бренд (только владелец).

Ответ `200`:

```json
{ "ok": true }
```

Побочный эффект (best-effort):
- В задачах текущего владельца, где `brandId === :brandId`, поле сбрасывается в `null`.

Ошибки:
- `400` `{ "error": "bad_brand_id" }`
- `403`, `404`, `500`

## Привязка бренда к заданиям (Tasks)

### Поле `brandId`

- В коллекции `tasks` хранится как `brandId: string | null`.
- В API задачи всегда отдают `brandId` как `string | null`.

### POST `/api/tasks` и PATCH `/api/tasks/:id`

- Принимают `brandId` **опционально**:
  - `brandId` отсутствует → не трогаем поле (в PATCH) / сохраняем `null` (в POST, если не пришёл)
  - `brandId: null` → отвязать бренд
  - `brandId: "<id>"` → привязать бренд

Валидация:
- Если `brandId` задан строкой — он обязан:
  - быть валидным Mongo ObjectId
  - существовать в `brands`
  - принадлежать текущему пользователю (customer)
- Иначе вернётся `400`:
  - `{ "error": "bad_brand_id" }`
  - `{ "error": "brand_not_found_or_not_owned" }`

## Индексы

Бэкенд создаёт индексы (best-effort) для быстрого листинга брендов:
- `brands: { ownerUserId: 1, createdAt: -1 }`
- `brands: { ownerMongoId: 1, createdAt: -1 }`

Опционально (если понадобится ускорить отвязку при удалении бренда):
- индекс для `tasks.brandId`

