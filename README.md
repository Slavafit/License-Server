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

**POST /admin/revoke** (и `/admin/restore`)
```json
{ "id": 123 }
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

После деплоя открой `https://<адрес-worker>/admin`. URL сервера определяется
автоматически, а Admin-ключ хранится только в памяти страницы и после перезагрузки
его нужно ввести снова.

Для production привяжи к Worker отдельный домен (например,
`licenses.example.com`) и закрой путь `/admin*` через Cloudflare Access. Разреши
вход только своему аккаунту и включи MFA. Публичные `/activate` и `/verify`
должны оставаться вне Access, иначе Android-приложения не смогут обращаться к ним.

Если панель размещена на другом origin, задай его точный адрес:

```bash
npx wrangler secret put ADMIN_ORIGIN
```

Значение должно выглядеть как `https://admin.example.com`, без завершающего `/`.
`*` использовать нельзя.

## Безопасное обновление существующей установки

Миграция `0002-security.sql` не удаляет и не изменяет строки в `licenses`, поэтому существующие
токены продолжают работать с `/verify`.

```bash
# 1. Рекомендуется сначала сделать экспорт/backup D1 через Cloudflare Dashboard.

# 2. Если app_name ещё не добавлялся, выполнить один раз:
npx wrangler d1 execute license-db --remote --file=migrate.sql

# 3. Добавить таблицы rate limit и аудита (команда безопасна при повторе):
npx wrangler d1 execute license-db --remote --file=migrations/0002-security.sql

# 4. Проверить сборку и задеплоить:
npx wrangler deploy --dry-run
npx wrangler deploy
```

Важно: повторная активация уже зарегистрированного устройства теперь требует
передать его текущий `token` в `POST /activate`. Обычный `POST /verify` не
изменился. Новую версию Android-клиента следует обновить так:

1. Если токен уже сохранён, вызывать `/verify` как раньше.
2. При повторном `/activate` передавать сохранённый `token`.
3. Обрабатывать `409` + `reason: "already_registered"` и предлагать обратиться
   в поддержку, а не запрашивать чужой токен повторно.

## Необязательная интеграция Firebase и склады

Firebase включается только для лицензий с `warehouse_id`. Обычное приложение
не передаёт `country_code` при активации: склад не назначается, ответы
`/activate` и `/verify` сохраняют прежние поля, без складских данных и
Firebase-токена. Повторный `/activate` по-прежнему требует сохранённый `token`.
`app_id` определяет приложение, а точный `warehouse_id` — границу доступа.
Разные приложения с `es-main` видят общие данные; `es-2` и `us-main` изолированы.
Страна — только необязательные метаданные (`ES`, `US`).

Пример активации FastScan:

```json
{"email":"user@example.com","device_id":"device-id","app_id":"com.ocr.fastscan","app_name":"FastScan","country_code":"US"}
```

Новый триал получает изолированный `license-{числовой_id}` и запрошенную
страну. Email — только контакт: он не даёт прав на склад. Каждое новое устройство
получает отдельный склад даже при совпадении email, приложения и страны.
Без страны новая лицензия имеет `NULL` в полях склада и страны. Существующее
устройство сохраняет назначенный склад при проверке собственным лицензионным
токеном; смена страны в Android не меняет доступ. Общие склады (`es-main`,
`es-2`, `us-main`) назначает только администратор, в том числе разным приложениям
вручную через панель лицензий. Подтверждение email и одноразовые коды переноса
устройства сейчас не реализованы.

После подтверждения администратор назначает склад через защищённый
`POST /admin/warehouse`:

```json
{"id":123,"warehouse_id":"es-2"}
```

Префикс `es-*` устанавливает `ES`, `us-*` — `US`. Формат склада:
`^[a-z0-9][a-z0-9-]{0,63}$`. `null` или `""` удаляет и склад, и страну.
`POST /admin/create` принимает необязательные `warehouse_id`, `country_code`;
конфликт страны с префиксом отклоняется. Без склада Firebase не включается.
Продление без этих полей сохраняет назначение. Панель предлагает Not used /
Spain / United States, подставляет склад, разрешает ввод `es-2` и удаление доступа.

Успешные ответы для складской лицензии дополнены `warehouse_id`, `country_code`
и при настроенном подписании `firebase_token`; прежние поля и HTTP-статусы
сохраняются. Это Firebase Custom Token RS256, подписанный через Web Crypto,
сроком на час, `uid: license:{id}` и claims: `warehouse_id`, `country_code`,
`license_active: true`, `license_expires_at` (Unix seconds, `0` для бессрочной),
`license_id`, `app_id`. Клиент обменивает его через Firebase
`signInWithCustomToken` проекта `fastscan-pro-1816f`. Custom Token сам по себе
не является Firebase ID token. При отсутствии настроек или ошибке подписи
лицензирование работает, `firebase_token` отсутствует, лог содержит безопасный
код ошибки. `GET /health` возвращает
`{"ok":true,"firebase_auth_configured":true}` только при наличии всех трёх
параметров; наличие не гарантирует валидность ключа.

В репозиторий добавлен `firestore.rules` для `/warehouses/{warehouseId}` и
всех вложенных документов. Правила требуют авторизацию, непустой строковый
`warehouse_id` в токене и точное совпадение
`request.auth.token.warehouse_id == warehouseId`, а также активную непросроченную
лицензию. Отсутствие claims запрещает доступ. Email, app_id и страна прав
на склад не дают. Временно исторические корневые документы `/shipments/{id}`
и `/box_entries/{id}` доступны только для чтения действующим непросроченным
лицензиям `es-main`. Запись и доступ к их подколлекциям запрещены. `es-2`,
`us-main`, изолированные склады и токены без `warehouse_id` не имеют доступа
к этим старым коллекциям. Все остальные корневые коллекции запрещены.
Применение правил в Firestore выполняется отдельно после проверки существующих
правил; Worker их не публикует. Не должно быть пересекающихся разрешающих
правил: Firestore объединяет совпавшие allow через OR.

Firebase Security Rules должны проверять точный подписанный `warehouse_id`,
активность и срок лицензии для каждого пути складских данных. Страна в Android
или claim страны не дают доступа. Удаление склада или отзыв прекращают выдачу
новых Custom Tokens; существующие Firebase-сессии требуют правил со сроком
действия и серверного механизма отзыва, если нужен немедленный отзыв доступа.
Одни claims не аннулируют уже открытую сессию.

### Перенос составов между складами

После административной смены `warehouse_id` сохранённые составы можно безопасно
скопировать через `POST /admin/firestore/migrate-order-contents`. По умолчанию
выполняется только проверка; существующие документы назначения не заменяются,
исходные документы не удаляются.

```json
{"source_warehouse":"license-19","target_warehouse":"es-main","dry_run":true}
```

Для копирования передайте `"dry_run": false`. Маршрут требует `X-Admin-Key`.

### Настройка и однократная миграция

В `wrangler.toml` указан `FIREBASE_PROJECT_ID = "fastscan-pro-1816f"`.
`FIREBASE_CLIENT_EMAIL` и `FIREBASE_PRIVATE_KEY` хранить только в Cloudflare
Secrets. Ключ — PKCS#8 PEM (`BEGIN PRIVATE KEY`), поддерживаются также
буквальные разделители `\n`. Приватный ключ, JSON сервисного аккаунта и
локальные файлы секретов нельзя коммитить.

Для существующей базы сначала примените `0002-security.sql`, если это ещё не
сделано. Затем выполните миграцию ниже **ровно один раз**, перед обновлением
Worker. Она добавляет поля и индекс, назначает `es-main` / `ES` **только**
существующим лицензиям `com.ocr.fastscan`. Остальные приложения остаются
`NULL` / `NULL`. Повторный ALTER завершится ошибкой. Для новой базы используйте
только `schema.sql`, эту миграцию после него запускать не нужно.

```bash
npx wrangler d1 execute license-db --remote \
  --file=migrations/0003-firebase-auth.sql

npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY

npx wrangler deploy
```

Проверки Firestore Rules в эмуляторе (требуется Java 21+):

```bash
npm run test:rules
```

Команда запускает только локальный эмулятор Firestore для `demo-license-server`.
JSON сервисного аккаунта и вход в Firebase не нужны. Проверяются точная изоляция
складов, общий склад разных приложений, отсутствие claims, независимость от
страны/email, срок лицензии, чтение старых коллекций только для `es-main` и
запрет остальных корневых коллекций. Правила и Worker не публикуются.

Локальные проверки (не меняют удалённую D1):

```bash
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler d1 execute license-db --local --file=schema.sql
```

## Архив старых лицензий

В панели `/admin` кнопка **«В архив»** скрывает запись из текущего списка.
Фильтр **«Текущие / Архив / Все»** позволяет посмотреть архив, а кнопка
**«Вернуть из архива»** возвращает запись. По умолчанию показаны текущие.
Счётчики и фильтры приложений относятся к загруженному списку (до 100 записей).

Архив — только видимость в панели: токен, активность, срок, склад и Firebase
не меняются. Для отключения старого устройства используйте **Revoke** отдельно.
Возврат из архива не восстанавливает отозванную лицензию. Продление не убирает
лицензию из архива. Автоматического архивирования или удаления нет.

Для обновления существующей установки сначала добавьте таблицу архива,
затем разверните Worker. Эта миграция безопасна при повторном запуске и не
изменяет существующие лицензии. Для новой базы таблица уже есть в `schema.sql`.

```bash
git pull origin master
npm ci
npx wrangler d1 execute license-db --remote --file=migrations/0004-license-archive.sql
npx wrangler deploy
```

Административный API (требует `X-Admin-Key`):

- `POST /admin/archive` с `{"id":123,"archived":true}` — в архив;
  `{"id":123,"archived":false}` — вернуть.
- `GET /admin/licenses?archived=0` — текущие (по умолчанию),
  `archived=1` — архив, `archived=all` — все.

Фильтр архива применяется до ограничения числа записей. Операции записываются
в административный аудит. Публичные `/activate` и `/verify` архив не учитывают.
