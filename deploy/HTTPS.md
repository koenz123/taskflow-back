# HTTPS через Nginx (рекомендуемый вариант)

## Важно про домен

Для “нормального” HTTPS без предупреждений в браузере нужен **домен**, который указывает на сервер.
Let’s Encrypt **не выдаёт сертификаты на голый IP**.

Если домена нет — см. секцию “Временный вариант: self-signed на IP”.

## 1) Подготовь DNS

Сделай A‑запись:
- `api.your-domain.com` → `167.172.102.120`

И/или тот домен, под который будет работать фронт/бэк.

## 2) Установи Nginx и Certbot (на сервере)

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 3) Положи конфиг Nginx

Скопируй `deploy/nginx/taskflow.conf` в:
- `/etc/nginx/sites-available/taskflow.conf`

Подставь:
- `server_name` (твой домен)
- пути к сертификатам (после certbot)

Активируй:

```bash
sudo ln -s /etc/nginx/sites-available/taskflow.conf /etc/nginx/sites-enabled/taskflow.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 4) Выпусти сертификат Let’s Encrypt

Проще всего через nginx плагин:

```bash
sudo certbot --nginx -d api.your-domain.com
```

После этого certbot сам пропишет `ssl_certificate`/`ssl_certificate_key` или ты можешь прописать вручную.

## 5) Включи автопродление

```bash
sudo systemctl enable --now certbot.timer
sudo systemctl status certbot.timer
```

## 6) Рекомендация по безопасности

Когда Nginx стоит перед бэком, лучше **не публиковать порт 4000 наружу**.

В `docker-compose.yml` можно заменить:
```yaml
ports:
  - "4000:4000"
```
на:
```yaml
ports:
  - "127.0.0.1:4000:4000"
```

Тогда извне доступ будет только через Nginx (443).

## 7) APP_BASE_URL

Поставь в `.env` (бэкенда) корректный HTTPS URL, например:
```env
APP_BASE_URL=https://api.your-domain.com
```

---

# Временный вариант: self-signed HTTPS на IP

Если домена нет, можно поднять self-signed сертификат (браузер будет ругаться).
Лучше не использовать для реальных пользователей.

