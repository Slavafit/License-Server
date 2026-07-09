# License Server

Лицензионный сервер для Android приложений. Cloudflare Workers + D1 (SQLite). Бесплатно, HTTPS из коробки.

---

## Стек

- **Cloudflare Workers** — бэкенд (TypeScript)
- **Cloudflare D1** — база данных (SQLite)
- **URL** — `https://license-server.YOUR_NAME.workers.dev`

---

## Первый деплой

```bash
npm install -g wrangler
wrangler login

# Создать БД и скопировать database_id в wrangler.toml
npx wrangler d1 create license-db

# Применить схему
npx wrangler d1 execute license-db --remote --file=schema.sql

# Задеплоить
npx wrangler deploy

# Установить Admin ключ
npx wrangler versions secret put ADMIN_KEY
npx wrangler versions deploy
```

## Обновление (миграция)

```bash
npx wrangler d1 execute license-db --remote --file=migrate.sql
npx wrangler deploy
npx wrangler versions secret put ADMIN_KEY
npx wrangler versions deploy
```

---

## API

### Публичные (из Android)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/activate` | Первый запуск — регистрация устройства, выдаёт триал 3 дня |
| POST | `/verify` | Проверка лицензии при каждом запуске |

**POST /activate**
```json
// Запрос
{ "email": "user@example.com", "device_id": "abc123", "app_id": "worktrack" }

// Ответ: новое устройство — триал
{ "ok": true, "token": "abc...", "status": "trial", "expires_at": 1234567890 }

// Ответ: уже активна
{ "ok": true, "token": "abc...", "status": "active", "expires_at": null }

// Ответ: триал истёк
{ "ok": false, "error": "Trial expired", "reason": "trial_expired" }
```

**POST /verify**
```json
// Запрос
{ "token": "abc...", "device_id": "abc123", "app_id": "worktrack" }

// Ответ: валидна
{ "ok": true, "valid": true, "status": "trial", "expires_at": 1234567890 }

// Ответ: невалидна
{ "ok": false, "valid": false, "reason": "trial_expired" }
// reason: not_found | revoked | expired | trial_expired | device_mismatch
```

---

### Админские (Header: X-Admin-Key)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/admin/create` | Выдать полную лицензию |
| POST | `/admin/revoke` | Отозвать лицензию |
| POST | `/admin/restore` | Восстановить лицензию |
| GET | `/admin/licenses` | Список всех лицензий |
| GET | `/admin/apps` | Статистика по приложениям |

**POST /admin/create**
```json
// Запрос
{ "email": "user@example.com", "device_id": "abc123", "app_id": "worktrack" }
// expires_days — необязательно, без него лицензия бессрочная

// Ответ
{ "ok": true, "token": "abc...", "action": "created" }
```

**POST /admin/revoke**
```json
{ "token": "abc..." }
// или
{ "device_id": "abc123", "app_id": "worktrack" }
```

**GET /admin/licenses**
```
/admin/licenses?app_id=worktrack&active=1
/admin/licenses?email=user@example.com
```

---

## Поток пользователя

```
Первый запуск
  → Вводит email
  → POST /activate → токен + триал 3 дня → приложение работает

Каждый запуск (кэш 24ч)
  → POST /verify → valid=true → работаем

Триал истёк
  → Экран "Запросить лицензию" → вводит email → POST /activate
  → Ты активируешь: POST /admin/create
  → Следующий запуск → status=active → полный доступ

Проверка офлайн
  → Кэш DataStore (24ч) → работает без интернета
```

---

## Добавить новое приложение

Ничего менять не нужно — используй новый `app_id`:
```
"app_id": "orderpacker"
"app_id": "fastscan"
```

---

## Android интеграция

Файлы в `app/src/main/java/.../license/`:
- `LicenseManager.kt` — логика активации и проверки
- `LicenseViewModel.kt` — ViewModel
- `LicenseScreen.kt` — UI (Compose)

Подключение в `MainActivity.kt`:
```kotlin
setContent {
    AppTheme {
        LicenseGate {
            // основной NavHost
        }
    }
}
```

Зависимость в `build.gradle`:
```kotlin
implementation "androidx.datastore:datastore-preferences:1.1.1"
```

---

## Дашборд

Открой `license-dashboard.html` в браузере. Настройки (URL + ключ) сохраняются локально.
