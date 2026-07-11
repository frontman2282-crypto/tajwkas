"""
Бот на aiogram + создание инвойса звёздами (Telegram Stars, валюта XTR)
для товара "dystopia" за 1 звезду.

Что делает этот файл:
1. Поднимает обычного aiogram-бота (long polling), который умеет
   принимать pre_checkout_query и successful_payment.
2. Поднимает рядом aiohttp веб-сервер с маршрутами:
   - POST /create_invoice — дёргает script.js, чтобы получить ссылку
     на инвойс и открыть нативное окно оплаты через tg.openInvoice().
   - POST /create_invoice_xrocket — то же самое, но оплата криптой через
     xRocket Pay (USDT и т.п.) вместо звёзд Telegram; возвращает ссылку
     на оплату и id счёта.
   - POST /create_case_invoice_xrocket — открытие кейса за XROCKET_CASE_PRICE
     в валюте xRocket (аналог /create_case_invoice, но криптой).
   - POST /xrocket_webhook — сюда xRocket присылает уведомление об оплате
     счёта (callbackUrl); по нему выдаётся товар/приз кейса.
   - GET  /xrocket_invoice_status — фронтенд опрашивает эту ручку, ожидая
     оплату счёта xRocket (полноценного колбэка вроде tg.openInvoice у
     xRocket нет).
   - POST /create_case_invoice — создаёт инвойс на CASE_PRICE_STARS
     звёзд (кейс теперь платный) для открытия кейса.
   - POST /claim_case_reward — забирает приз кейса (одноразовый
     промокод Kichiro-XXXXX со случайной скидкой: 3/5/10/15/30/50%)
     после того, как оплата инвойса из /create_case_invoice
     подтвердилась.
   - POST /open_case — старая ручка бесплатного открытия кейса,
     работает только если CASE_IS_FREE снова включат вручную.
   - GET  /validate_promo?code=... — проверяет промокод (статический
     или кейсовый) на экране оформления, до создания инвойса.
   - POST /delete_promo_codes — удаляет выбранные кейсовые промокоды
     текущего пользователя (мультивыбор в "Моих промокодах").
   - POST /delete_all_promo_codes — удаляет вообще все неиспользованные
     кейсовые промокоды текущего пользователя.
   - POST /check_ban — проверяет, забанен ли текущий пользователь
     мини-аппа (используется на splash-экране).
   - POST /admin/ban, /admin/unban, /admin/banned_list — управление
     банами (только для ADMIN_ID, см. константу ниже).
   - POST /admin/promo/create, /admin/promo/delete, /admin/promo/list —
     управление многоразовыми промокодами из админ-панели (доступно
     владельцу и назначенным админам).
   - POST /admin/user_promo_codes — по username или id пользователя
     отдаёт все его одноразовые кейсовые промокоды (в т.ч. уже
     использованные), доступно владельцу и назначенным админам.
   - POST /admin/user_promo_delete — удаляет ЛЮБОЙ (чужой) одноразовый
     кейсовый промокод по его коду, независимо от владельца и статуса
     "использован" — доступно владельцу и назначенным админам.
   - POST /admin/whoami — права текущего пользователя (is_admin/is_owner).
   - POST /admin/admins/list, /admin/admins/add, /admin/admins/remove —
     назначение и снятие админов (только для владельцев — ADMIN_ID и
     SECOND_OWNER_ID, см. OWNER_IDS/OWNER_USERNAMES).

Установка зависимостей (aiogram у тебя уже есть):
    pip install aiohttp aiohttp-cors

Запуск:
    python bot.py

Важно:
- Для оплаты звёздами provider_token в send_invoice / create_invoice_link
  должен быть пустой строкой "", а currency = "XTR".
- prices указываются в LabeledPrice, amount — это просто целое число звёзд
  (без умножения
  на 100, как в обычных валютах — у звёзд множитель 1).
- Мини-апп (index.html/style.css/script.js) должен быть захостен на
  HTTPS-домене (например, GitHub Pages, Vercel, или твой же сервер) и
  подключён в @BotFather через /newapp или как Menu Button.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import asyncio
import math
import random
import string
import time

import aiohttp
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    LabeledPrice,
    PreCheckoutQuery,
    WebAppInfo,
)
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.utils.web_app import safe_parse_webapp_init_data

import os

# ====== Настройки ======
# Токен бери из переменных окружения хостинга (Render: Environment -> Add variable),
# либо, для быстрого локального теста, можно временно вписать строкой прямо тут.
BOT_TOKEN = os.environ.get("BOT_TOKEN", "ВСТАВЬ_СЮДА_ТОКЕН_БОТА")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://твой-адрес.onrender.com")
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8080))  # Render подставит свой PORT сам

# ====== xRocket Pay (оплата криптой прямо в мини-аппе) ======
# API-ключ бери в @xRocket -> Pay -> App Settings -> Create App (или в
# личном кабинете xRocket Pay). ВАЖНО: сюда идёт именно xRocket Pay API
# ключ, а не токен обычного Telegram-бота.
#
# ВНИМАНИЕ: названия полей/эндпоинтов ниже (Rocket-Pay-Key, /tg-invoices,
# формат вебхука и подписи) собраны по памяти без сверки с актуальной
# документацией xRocket (по просьбе пользователя — без web-поиска). Если
# запросы будут падать с ошибкой формата, свериться с официальной
# документацией https://pay.xrocket.tg/api или ботом @xRocket и поправить
# только xrocket_request()/create_invoice_xrocket_handler/
# xrocket_webhook_handler — остальной код (хранилище, выдача покупки,
# фронтенд) менять не придётся.
XROCKET_API_KEY = os.environ.get("XROCKET_API_KEY", "")
XROCKET_API_BASE = os.environ.get("XROCKET_API_BASE", "https://pay.xrocket.tg")
XROCKET_CURRENCY = os.environ.get("XROCKET_CURRENCY", "USDT")

# Секрет для проверки подписи вебхука. У xRocket подпись обычно совпадает
# с самим API-ключом (или отдельным webhook-секретом из настроек приложения
# — если у тебя такой есть, впиши его сюда через переменную окружения).
XROCKET_WEBHOOK_SECRET = os.environ.get("XROCKET_WEBHOOK_SECRET", XROCKET_API_KEY)

# Цены тарифов в валюте XROCKET_CURRENCY (по умолчанию USDT). Коды должны
# совпадать с DURATIONS выше и с XROCKET_PRICES в script.js. Поменяй суммы
# под свои цены.
XROCKET_PRICES = {
    "7d": 6.0,
    "30d": 10.0,
    "12m": 80.0,
}

# Цена платного открытия кейса в XROCKET_CURRENCY.
XROCKET_CASE_PRICE = 0.8

# ====== Админ ======
# Единственный пользователь, которому доступна вкладка "Админ-панель" в
# мини-аппе. Проверка всегда идёт по user_id, извлечённому из подписанного
# initData (см. resolve_user), а не по тому, что прислал клиент, — так
# никто другой не сможет открыть панель, даже подделав запрос.
ADMIN_ID = 8606714114
ADMIN_USERNAME = "meaninglessperson"  # только для справки/отображения

# Второй владелец — имеет ровно те же права, что и ADMIN_ID: доступ к
# админ-панели, бан/промокоды, а также (в отличие от обычных назначенных
# админов) право сам назначать и снимать других админов. Проверка прав
# везде идёт по множеству OWNER_IDS/OWNER_USERNAMES, а не по одному ID —
# см. is_owner_init_data ниже.
SECOND_OWNER_ID = 6862094308
SECOND_OWNER_USERNAME = "alyuplost"

OWNER_IDS = {ADMIN_ID, SECOND_OWNER_ID}
OWNER_USERNAMES = {ADMIN_USERNAME.lower(), SECOND_OWNER_USERNAME.lower()}

# Каталог товаров: id -> (название, описание, цена в звёздах)
PRODUCTS = {
    "dystopia": {
        "title": "Dystopia",
        "description": (
            "Dystopia — это премиальный игровой проект нового уровня, "
            "созданный для тех, кто хочет больше, чем обычный опыт в игре. "
            "Это система уникальных возможностей, расширенного функционала "
            "и особого статуса, который выделяет тебя среди остальных игроков."
        ),
        "price": 2,
    }
}

# Доступные сроки доступа и их цена в звёздах (Telegram Stars).
# Коды ("7d", "30d", "12m") должны совпадать с DURATIONS в script.js —
# именно они прилетают в payload инвойса и в successful_payment.
# available: False — тариф "нет в наличии": инвойс на него не создаётся
# (см. проверку ниже в create_invoice_handler / create_invoice_xrocket_handler),
# даже если кто-то попробует обратиться к API напрямую, минуя интерфейс.
DURATIONS = {
    "7d": {"label": "7 дней", "price": 1, "available": True},
    "30d": {"label": "30 дней", "price": 500, "available": False},
    "12m": {"label": "12 месяцев", "price": 4000, "available": False},
}

# ====== Промокоды ======
# Статические промокоды: ключ — код в нижнем регистре (сравнение
# регистронезависимое), discount_percent — скидка в процентах.
# Чтобы добавить новый постоянный промокод, просто добавь запись сюда.
PROMO_CODES = {
    "idea67": {"discount_percent": 50},
}

# ====== Промокоды из кейса ======
# Кейс выдаёт одноразовый промокод формата "Kichiro-XXXXX" (5 случайных
# букв, в любом регистре, без цифр). Шансы ниже — это ОТНОСИТЕЛЬНЫЕ веса
# выпадения, а не проценты от 100. При сумме весов 331 фактические шансы:
# 3% = 48.3%, 5% = 45.3%, 10% = 3.6%, 15% = 1.5%, 30% = 0.9%, 50% = 0.3%.
# Шанс на 10% сильно понижен по просьбе — было 60 из 379 = 15.8%, стало
# 12 из 331 = 3.6% (более чем в 4 раза реже). Выбор по-прежнему полностью
# случайный (random.choices) — поменяй числа, если нужны другие шансы.
CASE_PRIZES = [
    (3, 160),
    (5, 150),
    (10, 12),
    (15, 5),
    (30, 3),
    (50, 1),
]

# Кейс платный: открыть его можно за CASE_PRICE_STARS звёзд Telegram
# Stars (оплата — обычный инвойс, как и при покупке товара, см.
# create_case_invoice_handler и successful_payment_handler).
CASE_IS_FREE = False
CASE_PRICE_STARS = 60

# Хранилище сгенерированных кейсом промокодов: КОД (в верхнем регистре) ->
# {"code": оригинальное написание, "discount_percent": int, "used": bool}.
#
# ВАЖНО: раньше это была чистая память процесса, которая обнулялась при
# каждом рестарте сервера (в т.ч. на бесплатных тарифах хостингов, которые
# "засыпают" и перезапускаются при простое). Из-за этого промокод мог
# успешно провалидироваться в один момент, а через какое-то время (после
# незаметного рестарта) сервер уже "не знал" о нём — именно это выглядело
# как баг "промокод сработал, а потом вдруг не найден". Теперь состояние
# сохраняется в JSON-файл рядом со скриптом и переживает рестарты процесса.
# Для боевого использования всё равно лучше подключить нормальную БД —
# файл не защищён от одновременной записи из нескольких процессов.
PROMO_STORE_PATH = os.environ.get("PROMO_STORE_PATH", "generated_promos.json")


def _load_generated_promos() -> dict[str, dict]:
    try:
        with open(PROMO_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_generated_promos() -> None:
    try:
        with open(PROMO_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(GENERATED_PROMOS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", PROMO_STORE_PATH)


GENERATED_PROMOS: dict[str, dict] = _load_generated_promos()


# ====== Ожидающие выдачи призы кейса (после оплаты звёздами) ======
# Открытие кейса теперь платное (см. CASE_PRICE_STARS), поэтому оно, как и
# покупка товара, идёт через create_invoice_link + successful_payment —
# сам приз "крутится" не сразу по клику, а только когда пришло реальное
# подтверждение оплаты (successful_payment_handler). Приз кладётся сюда,
# а мини-апп забирает его через POST /claim_case_reward (опрашивает эту
# ручку короткими интервалами сразу после того, как Telegram сообщил
# статус "paid").
# Ключ — user_id, значение — {"code": ..., "discount_percent": int}.
PENDING_CASE_STORE_PATH = os.environ.get("PENDING_CASE_STORE_PATH", "pending_case_rewards.json")


def _load_pending_case_rewards() -> dict[str, dict]:
    try:
        with open(PENDING_CASE_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_pending_case_rewards() -> None:
    try:
        with open(PENDING_CASE_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(PENDING_CASE_REWARDS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", PENDING_CASE_STORE_PATH)


PENDING_CASE_REWARDS: dict[str, dict] = _load_pending_case_rewards()


# ====== Счета xRocket Pay (крипта) ======
# Пока Telegram Stars подтверждает оплату через pre_checkout/successful_payment,
# у xRocket другая модель: мы создаём счёт через их API, пользователь платит
# на отдельной странице/в боте @xRocket, а xRocket сообщает нам об оплате
# через вебхук POST /xrocket_webhook. Чтобы к этому моменту знать, ЧТО
# именно купили (товар/срок/промокод) и КОМУ выдать доступ, сохраняем эти
# данные тут сразу при создании счёта, ключ — id счёта (строка).
#
# Запись: {"kind": "product"|"case", "user_id": int|None,
#          "product_id": str, "duration_code": str, "promo_field": str,
#          "amount": float, "status": "pending"|"paid", "created": float}
XROCKET_INVOICES_PATH = os.environ.get("XROCKET_INVOICES_PATH", "xrocket_invoices.json")


def _load_xrocket_invoices() -> dict[str, dict]:
    try:
        with open(XROCKET_INVOICES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_xrocket_invoices() -> None:
    try:
        with open(XROCKET_INVOICES_PATH, "w", encoding="utf-8") as f:
            json.dump(XROCKET_INVOICES, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", XROCKET_INVOICES_PATH)


XROCKET_INVOICES: dict[str, dict] = _load_xrocket_invoices()


# ====== Ключи доступа, выдаваемые автоматически после оплаты ======
# Список доступных ключей, зашитый в код — начальный набор. Дополнительные
# ключи можно добавлять через админ-панель (кнопка "Добавить ключ" на
# вкладке "Ключи доступа") — они хранятся отдельно, в EXTRA_ACCESS_KEYS
# (см. ниже), и не требуют деплоя. Порядок важен: ключи выдаются строго по
# очереди (сначала из ACCESS_KEYS, потом из EXTRA_ACCESS_KEYS), и каждый
# ключ может быть выдан только ОДИН раз, любому из покупателей. Как только
# ключ выдан — он больше никому не достанется повторно.
#
# Ключи из этого списка (ACCESS_KEYS) считаются ключами на срок "7d" —
# единственный тариф, который был в наличии на момент, когда они были
# зашиты в код. Если нужен ключ на другой срок — добавляй его через
# админ-панель с выбором нужного срока (см. EXTRA_ACCESS_KEYS ниже).
ACCESS_KEYS: list[str] = [
    # Первые 3 ключа (DYST-SBF36-..., DYST-3GC7W-..., DYST-E9196-...) были
    # выданы покупателям и удалены из списка по просьбе владельца — новые
    # ключи добавляются через админ-панель (EXTRA_ACCESS_KEYS).
]

# Ключи, добавленные владельцем/админом через админ-панель в рантайме (без
# деплоя). Хранятся отдельно от ACCESS_KEYS и переживают рестарты — только
# если каталог, где лежит EXTRA_ACCESS_KEYS_PATH, смонтирован как
# persistent volume (см. инструкцию для Railway).
#
# Формат: список словарей {"key": str, "duration_code": str}, где
# duration_code — один из ключей DURATIONS ("7d"/"30d"/"12m" и т.п.),
# срок, на который действует именно этот ключ. Так при оплате конкретного
# тарифа покупателю выдаётся ключ именно под этот тариф, а не первый
# попавшийся в общей очереди.
EXTRA_ACCESS_KEYS_PATH = os.environ.get(
    "EXTRA_ACCESS_KEYS_PATH", "extra_access_keys.json"
)


def _load_extra_access_keys() -> list[dict]:
    try:
        with open(EXTRA_ACCESS_KEYS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

    if not isinstance(data, list):
        return []

    # Обратная совместимость: старый формат файла — просто список строк
    # (когда срок ключей не выбирался и все они считались "7d").
    result = []
    for item in data:
        if isinstance(item, str):
            result.append({"key": item, "duration_code": "7d"})
        elif isinstance(item, dict) and item.get("key"):
            result.append({
                "key": item["key"],
                "duration_code": item.get("duration_code") or "7d",
            })
    return result


def _save_extra_access_keys() -> None:
    try:
        with open(EXTRA_ACCESS_KEYS_PATH, "w", encoding="utf-8") as f:
            json.dump(EXTRA_ACCESS_KEYS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", EXTRA_ACCESS_KEYS_PATH)


EXTRA_ACCESS_KEYS: list[dict] = _load_extra_access_keys()


def _extra_key_strings() -> list[str]:
    return [item["key"] for item in EXTRA_ACCESS_KEYS]


def key_duration_code(key: str) -> str:
    """Возвращает код срока (7d/30d/12m/...), к которому привязан ключ.
    Ключи, зашитые в ACCESS_KEYS (без явного срока), считаются ключами на
    7 дней (см. комментарий у ACCESS_KEYS)."""
    for item in EXTRA_ACCESS_KEYS:
        if item["key"] == key:
            return item.get("duration_code", "7d")
    return "7d"


def all_access_keys(duration_code: str | None = None) -> list[str]:
    """Полный список ключей на выдачу: сначала зашитые в код (ACCESS_KEYS),
    потом добавленные через админ-панель (EXTRA_ACCESS_KEYS), в порядке
    добавления. Если передан duration_code — возвращает только ключи,
    привязанные к этому сроку."""
    keys = ACCESS_KEYS + _extra_key_strings()
    if duration_code is None:
        return keys
    return [key for key in keys if key_duration_code(key) == duration_code]


# Ручной переключатель "в наличии / нет в наличии" из админ-панели. Если
# None — наличие считается автоматически (есть ли хоть один невыданный
# ключ). Если True/False — админ явно задал состояние вручную, и оно
# главнее автоматического подсчёта (например, чтобы скрыть Stars/xRocket
# заранее, не дожидаясь, пока реально кончатся ключи, или наоборот —
# показать "в наличии", пока новые ключи ещё не добавлены).
STOCK_OVERRIDE_PATH = os.environ.get("STOCK_OVERRIDE_PATH", "stock_override.json")


def _load_stock_override() -> dict[str, bool]:
    try:
        with open(STOCK_OVERRIDE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_stock_override() -> None:
    try:
        with open(STOCK_OVERRIDE_PATH, "w", encoding="utf-8") as f:
            json.dump(STOCK_OVERRIDE, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", STOCK_OVERRIDE_PATH)


STOCK_OVERRIDE: dict[str, bool] = _load_stock_override()

# Ссылка, которая отправляется покупателю вместе с ключом (в сообщении
# "Файл тут: ..."). Поменяй на актуальную ссылку, если она изменится.
DELIVERY_FILE_LINK = os.environ.get(
    "DELIVERY_FILE_LINK", "https://t.me/+6Egjv4VK5IplYTY6"
)

# Хранилище выданных ключей: ключ (из ACCESS_KEYS) -> {"user_id": int|None,
# "product_id": str, "duration_code": str, "issued_at": float}.
# Переживает рестарты процесса — но только если каталог, где лежит
# ISSUED_KEYS_PATH, смонтирован как persistent volume (см. инструкцию
# для Railway). Без volume Railway стирает файл при каждом деплое.
ISSUED_KEYS_PATH = os.environ.get("ISSUED_KEYS_PATH", "issued_keys.json")


def _load_issued_keys() -> dict[str, dict]:
    try:
        with open(ISSUED_KEYS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_issued_keys() -> None:
    try:
        with open(ISSUED_KEYS_PATH, "w", encoding="utf-8") as f:
            json.dump(ISSUED_KEYS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", ISSUED_KEYS_PATH)


ISSUED_KEYS: dict[str, dict] = _load_issued_keys()

# Хранилище уже обработанных оплат: telegram_payment_charge_id (для звёзд)
# или invoice_id (для xRocket) -> выданный ключ (или None, если товар был
# без ключа, например открытие кейса). Нужно, чтобы если Telegram/xRocket
# пришлют уведомление об одной и той же оплате повторно (например, из-за
# рестарта бота в неудачный момент), мы не выдавали второй ключ за одну и
# ту же оплату — а просто вернули тот же ключ, что был выдан в первый раз.
PROCESSED_PAYMENTS_PATH = os.environ.get(
    "PROCESSED_PAYMENTS_PATH", "processed_payments.json"
)


def _load_processed_payments() -> dict[str, str | None]:
    try:
        with open(PROCESSED_PAYMENTS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_processed_payments() -> None:
    try:
        with open(PROCESSED_PAYMENTS_PATH, "w", encoding="utf-8") as f:
            json.dump(PROCESSED_PAYMENTS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", PROCESSED_PAYMENTS_PATH)


PROCESSED_PAYMENTS: dict[str, str | None] = _load_processed_payments()

# Лок нужен, чтобы при одновременном подтверждении двух оплат (например,
# звёзды и xRocket почти одновременно) один и тот же ключ не выдался
# дважды разным людям — без лока обе оплаты могли бы одновременно увидеть
# ключ свободным и выдать его дважды.
_KEY_ISSUE_LOCK = asyncio.Lock()


async def issue_next_key(
    user_id: int | None,
    product_id: str,
    duration_code: str,
    payment_id: str | None = None,
) -> str | None:
    """Атомарно выдаёт следующий свободный ключ из ACCESS_KEYS (строго по
    порядку) и помечает его выданным, чтобы он не достался никому ещё раз.
    Возвращает None, если свободных ключей больше нет.

    Если передан payment_id и такая оплата уже была обработана раньше
    (Telegram/xRocket повторно прислали уведомление об одной и той же
    оплате) — просто возвращает тот же ключ, что был выдан в первый раз,
    вместо того чтобы выдавать новый."""
    async with _KEY_ISSUE_LOCK:
        if payment_id is not None and payment_id in PROCESSED_PAYMENTS:
            return PROCESSED_PAYMENTS[payment_id]

        # Ключи выдаются только из очереди, привязанной к оплаченному
        # сроку (duration_code) — покупатель тарифа "30 дней" не должен
        # получить ключ, помеченный как "7 дней", даже если он свободен.
        for key in all_access_keys(duration_code):
            if key not in ISSUED_KEYS:
                ISSUED_KEYS[key] = {
                    "user_id": user_id,
                    "product_id": product_id,
                    "duration_code": duration_code,
                    "issued_at": time.time(),
                }
                _save_issued_keys()
                if payment_id is not None:
                    PROCESSED_PAYMENTS[payment_id] = key
                    _save_processed_payments()
                return key

        if payment_id is not None:
            PROCESSED_PAYMENTS[payment_id] = None
            _save_processed_payments()
    return None


def has_available_key(product_id: str = "dystopia", duration_code: str | None = None) -> bool:
    """Проверяет, показывать ли товар (или конкретный тариф) как "в
    наличии". Если админ явно задал состояние вручную в админ-панели
    (STOCK_OVERRIDE) — используется оно (оно общее для товара, не зависит
    от срока). Иначе считается автоматически: остался ли хоть один
    свободный (ещё не выданный) ключ — среди всех ключей, либо, если
    передан duration_code, среди ключей именно этого срока."""
    override = STOCK_OVERRIDE.get(product_id)
    if override is not None:
        return override
    return any(key not in ISSUED_KEYS for key in all_access_keys(duration_code))


# ====== Забаненные пользователи (админ-панель) ======
# Хранилище: ключ — произвольный внутренний id записи (строка), значение —
# {"user_id": int|None, "username": str|None (нижний регистр, без "@")}.
# Бан можно выдать и по числовому id, и по username — вторым способом
# можно забанить человека, который вообще ни разу не открывал бота
# (бэкенду не нужно "знать" его id заранее, потому что initData самого
# забаненного пользователя при следующем открытии мини-аппа принесёт и
# его username, и его id, и мы сможем сопоставить запись).
BANNED_STORE_PATH = os.environ.get("BANNED_STORE_PATH", "banned_users.json")


def _load_banned_users() -> dict[str, dict]:
    try:
        with open(BANNED_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_banned_users() -> None:
    try:
        with open(BANNED_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(BANNED_USERS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", BANNED_STORE_PATH)


BANNED_USERS: dict[str, dict] = _load_banned_users()


def _find_ban_entry(user_id: int | None, username: str | None) -> str | None:
    """Ищет запись о бане по id или по username. Возвращает ключ записи
    в BANNED_USERS, либо None, если пользователь не забанен."""
    uname = username.lower().lstrip("@") if username else None
    for key, entry in BANNED_USERS.items():
        if user_id is not None and entry.get("user_id") == user_id:
            return key
        if uname and entry.get("username") == uname:
            return key
    return None


def is_banned(user_id: int | None, username: str | None) -> bool:
    return _find_ban_entry(user_id, username) is not None


def is_banned_and_backfill(user_id: int | None, username: str | None) -> bool:
    """То же, что is_banned, но дополнительно "фиксирует" числовой id
    пользователя в записи о бане, если её там раньше не было.

    Раньше бан, выданный по username (например, на пользователя, который
    ни разу не открывал бота), переставал действовать, если человек потом
    менял username — запись просто переставала совпадать ни по чему.
    Теперь при каждом заходе в бота/мини-апп мы смотрим подписанный
    initData и, если он совпал с существующей записью о бане, тут же
    дописываем в неё user_id (он не меняется никогда, в отличие от
    username) — начиная с этого момента бан работает даже после смены
    username."""
    key = _find_ban_entry(user_id, username)
    if key is None:
        return False

    entry = BANNED_USERS[key]
    if user_id is not None and entry.get("user_id") != user_id:
        entry["user_id"] = user_id
        _save_banned_users()

    return True


def _parse_ban_target(raw: str) -> tuple[int | None, str | None]:
    """Разбирает то, что ввёл админ в поле "юзернейм или id" — либо
    числовой id, либо username (с "@" или без)."""
    target = raw.strip().lstrip("@")
    if target.isdigit():
        return int(target), None
    return None, target.lower() if target else None


def _resolve_target_user(raw: str) -> tuple[int | None, str | None]:
    """Как _parse_ban_target, но если ввели username, а не id, дополнительно
    пытается найти реальный user_id через USER_DIRECTORY — это нужно,
    чтобы искать промокоды пользователя по username (сами промокоды в
    GENERATED_PROMOS привязаны только к id)."""
    target_id, target_username = _parse_ban_target(raw)
    if target_id is None and target_username:
        target_id = find_user_id_by_username(target_username)
    return target_id, target_username


# ====== Дополнительные админы (назначаются владельцем из панели) ======
# ADMIN_ID — единственный "владелец", он всегда админ и только он может
# назначать/снимать остальных админов. Остальные админы из этого списка
# получают доступ к вкладке "Админ-панель" (бан, промокоды), но не могут
# сами управлять списком админов — это решает is_owner_init_data ниже.
# Хранилище устроено так же, как BANNED_USERS: ключ — внутренний id
# записи, значение — {"user_id": int|None, "username": str|None}.
ADMINS_STORE_PATH = os.environ.get("ADMINS_STORE_PATH", "admins.json")


def _load_admins() -> dict[str, dict]:
    try:
        with open(ADMINS_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_admins() -> None:
    try:
        with open(ADMINS_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(ADMINS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", ADMINS_STORE_PATH)


ADMINS: dict[str, dict] = _load_admins()


def _find_admin_entry(user_id: int | None, username: str | None) -> str | None:
    """Ищет запись о назначенном админе по id или по username. Возвращает
    ключ записи в ADMINS, либо None, если пользователь не назначен."""
    uname = username.lower().lstrip("@") if username else None
    for key, entry in ADMINS.items():
        if user_id is not None and entry.get("user_id") == user_id:
            return key
        if uname and entry.get("username") == uname:
            return key
    return None


def is_assigned_admin(user_id: int | None, username: str | None) -> bool:
    return _find_admin_entry(user_id, username) is not None


# ====== Промокоды, созданные админом ======
# В отличие от GENERATED_PROMOS (одноразовые призы из кейса, привязанные к
# конкретному пользователю), это многоразовые промокоды с произвольным
# названием, скидкой и лимитом активаций — их создаёт админ вручную из
# админ-панели. Ключ — код в ВЕРХНЕМ регистре, значение — {"code": как
# ввёл админ, "discount_percent": int, "max_activations": int,
# "activations": int (сколько раз уже использован)}.
ADMIN_PROMO_STORE_PATH = os.environ.get("ADMIN_PROMO_STORE_PATH", "admin_promos.json")


def _load_admin_promos() -> dict[str, dict]:
    try:
        with open(ADMIN_PROMO_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_admin_promos() -> None:
    try:
        with open(ADMIN_PROMO_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(ADMIN_PROMOS, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", ADMIN_PROMO_STORE_PATH)


ADMIN_PROMOS: dict[str, dict] = _load_admin_promos()


# ====== Справочник "id <-> username" ======
# GENERATED_PROMOS хранит только user_id, а не username, поэтому чтобы
# админ мог найти промокоды пользователя по username (а не только по id),
# нужно где-то сопоставлять id и username. Это хранилище заполняется
# автоматически (см. remember_user) при каждом запросе с валидным
# подписанным initData — то есть практически при любом открытии мини-аппа.
# Ключ — id пользователя (строкой), значение — {"user_id": int, "username":
# str|None}.
USER_DIRECTORY_PATH = os.environ.get("USER_DIRECTORY_PATH", "user_directory.json")


def _load_user_directory() -> dict[str, dict]:
    try:
        with open(USER_DIRECTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_user_directory() -> None:
    try:
        with open(USER_DIRECTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(USER_DIRECTORY, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("Не удалось сохранить %s", USER_DIRECTORY_PATH)


USER_DIRECTORY: dict[str, dict] = _load_user_directory()


def remember_user(user_id: int | None, username: str | None) -> None:
    """Запоминает соответствие id <-> username, чтобы позже можно было
    найти пользователя по username (например, в /admin/user_promo_codes),
    даже если сам промокод хранит только id."""
    if user_id is None:
        return
    key = str(user_id)
    entry = USER_DIRECTORY.get(key)
    # Не затираем уже известный username значением None — resolve_user_id
    # (который username вообще не знает) не должен "забывать" то, что уже
    # выяснил resolve_user в другом запросе.
    if entry is None:
        USER_DIRECTORY[key] = {"user_id": user_id, "username": username}
        _save_user_directory()
    elif username is not None and entry.get("username") != username:
        entry["username"] = username
        _save_user_directory()


def find_user_id_by_username(username: str | None) -> int | None:
    """Ищет id пользователя по username в справочнике USER_DIRECTORY."""
    if not username:
        return None
    uname = username.lower().lstrip("@")
    for entry in USER_DIRECTORY.values():
        if entry.get("username") == uname:
            return entry.get("user_id")
    return None


def resolve_user_id(init_data_raw: str | None) -> int | None:
    """Достаёт и проверяет user_id из initData Telegram Mini App.

    initData подписан ботом, поэтому safe_parse_webapp_init_data сама
    проверяет подпись — доверять "сырому" user_id из тела запроса без
    этой проверки нельзя (клиент мог бы подставить чужой id и подсмотреть
    чужие промокоды). Если подпись невалидна, просрочена или initData не
    передан — просто возвращаем None (код не привяжется ни к какому
    пользователю и не попадёт в "Мои промокоды", но откроется нормально).
    """
    if not init_data_raw:
        return None
    try:
        parsed = safe_parse_webapp_init_data(token=BOT_TOKEN, init_data=init_data_raw)
        if not parsed.user:
            return None
        username = parsed.user.username.lower() if parsed.user.username else None
        remember_user(parsed.user.id, username)
        return parsed.user.id
    except Exception:
        return None


def resolve_user(init_data_raw: str | None) -> tuple[int | None, str | None]:
    """То же, что resolve_user_id, но также возвращает username (в нижнем
    регистре, без "@"), если он есть. Используется для проверки бана (бан
    может быть выдан и по id, и по username) и для проверки прав админа.
    """
    if not init_data_raw:
        return None, None
    try:
        parsed = safe_parse_webapp_init_data(token=BOT_TOKEN, init_data=init_data_raw)
        if not parsed.user:
            return None, None
        username = parsed.user.username.lower() if parsed.user.username else None
        remember_user(parsed.user.id, username)
        return parsed.user.id, username
    except Exception:
        return None, None


def is_owner_user(user_id: int | None, username: str | None) -> bool:
    """Проверяет, является ли пользователь одним из владельцев
    (ADMIN_ID или SECOND_OWNER_ID) — по id или по username."""
    if user_id is not None and user_id in OWNER_IDS:
        return True
    if username and username.lower() in OWNER_USERNAMES:
        return True
    return False


def is_owner_init_data(init_data_raw: str | None) -> bool:
    """Проверяет, что запрос реально пришёл от одного из владельцев — по
    подписанному initData, а не по тому, что написал клиент. Только
    владельцы могут назначать и снимать остальных админов."""
    user_id, username = resolve_user(init_data_raw)
    return is_owner_user(user_id, username)


def is_admin_init_data(init_data_raw: str | None) -> bool:
    """Проверяет, что запрос реально пришёл от админа — одного из
    владельцев или пользователя, назначенного админом из панели. Право
    проверяется по подписанному initData, а не по тому, что прислал
    клиент."""
    user_id, username = resolve_user(init_data_raw)
    if is_owner_user(user_id, username):
        return True
    return is_assigned_admin(user_id, username)


def roll_case_prize() -> int:
    """Выбирает размер скидки (%) с учётом весов CASE_PRIZES."""
    discounts = [d for d, _ in CASE_PRIZES]
    weights = [w for _, w in CASE_PRIZES]
    return random.choices(discounts, weights=weights, k=1)[0]


def generate_case_code() -> str:
    """Генерирует уникальный код вида Kichiro-XXXXX (5 случайных букв,
    без цифр) и резервирует его."""
    while True:
        suffix = "".join(random.choices(string.ascii_letters, k=5))
        code = f"Kichiro-{suffix}"
        if code.upper() not in GENERATED_PROMOS:
            return code


def resolve_promo(promo_code_raw: str | None) -> tuple[int, dict | None]:
    """Проверяет промокод (статический или кейсовый) и считает скидку.

    Возвращает (discount_percent, метаданные_или_None). Кейсовые коды
    одноразовые: уже использованный код считается невалидным.
    """
    if not promo_code_raw:
        return 0, None

    raw = promo_code_raw.strip()

    static = PROMO_CODES.get(raw.lower())
    if static:
        return static["discount_percent"], {"type": "static"}

    key = raw.upper()

    admin_promo = ADMIN_PROMOS.get(key)
    if admin_promo and admin_promo["activations"] < admin_promo["max_activations"]:
        return admin_promo["discount_percent"], {"type": "admin", "key": key}

    dynamic = GENERATED_PROMOS.get(key)
    if dynamic and not dynamic["used"]:
        return dynamic["discount_percent"], {"type": "case", "key": key}

    return 0, None


def apply_promo(base_price: int, promo_code: str | None) -> tuple[int, dict | None]:
    """Считает итоговую цену в звёздах с учётом промокода (статического
    или сгенерированного кейсом).

    Возвращает (итоговая_цена, метаданные_промокода_или_None).
    Цена в Stars — это целое число, поэтому скидка округляется вниз
    (math.floor), а не до ближайшего целого: с обычным round() при
    небольшой базовой цене (например, 2 ★) многие проценты скидки
    (10%, 20%, 25%...) округлялись ОБРАТНО к исходной цене — промокод
    формально считался применённым (скидка% в ответе была верной), но
    реально оплатить нужно было ту же сумму, и выглядело так, будто
    промокод "не работает". floor гарантирует, что любая ненулевая
    скидка при base_price > 1 хоть немного, но снижает цену. Итоговая
    цена никогда не опускается ниже 1 звезды.
    """
    discount_percent, promo_meta = resolve_promo(promo_code)
    if promo_meta is None:
        return base_price, None

    final_price = max(1, math.floor(base_price * (1 - discount_percent / 100)))
    promo_meta = {**promo_meta, "discount_percent": discount_percent}
    return final_price, promo_meta


def apply_promo_float(base_price: float, promo_code: str | None) -> tuple[float, dict | None]:
    """То же самое, что apply_promo, но для цен в xRocket (USDT и т.п.),
    где сумма не целое число звёзд, а дробная — округляем до центов
    (2 знака), а не до целого."""
    discount_percent, promo_meta = resolve_promo(promo_code)
    if promo_meta is None:
        return round(base_price, 2), None

    final_price = max(0.01, round(base_price * (1 - discount_percent / 100), 2))
    promo_meta = {**promo_meta, "discount_percent": discount_percent}
    return final_price, promo_meta


async def xrocket_request(method: str, path: str, json_body: dict | None = None) -> dict:
    """Запрос к xRocket Pay API. Бросает исключение при ошибке — вызывающий
    код должен ловить её и отвечать 502 клиенту.

    ВНИМАНИЕ (см. комментарий у XROCKET_API_KEY выше): заголовок
    "Rocket-Pay-Key" и базовый путь "/tg-invoices" указаны по памяти, без
    сверки с документацией — если xRocket поменял название заголовка или
    путь, поправь их здесь."""
    url = f"{XROCKET_API_BASE.rstrip('/')}{path}"
    headers = {
        "Rocket-Pay-Key": XROCKET_API_KEY,
        "Content-Type": "application/json",
    }
    async with aiohttp.ClientSession() as session:
        async with session.request(method, url, headers=headers, json=json_body, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"xRocket API {method} {path} -> {resp.status}: {text}")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                raise RuntimeError(f"xRocket API {method} {path}: не JSON-ответ: {text}")


def verify_xrocket_signature(raw_body: bytes, signature: str | None) -> bool:
    """Сверяет подпись вебхука xRocket. Формат подписи (HMAC-SHA256 от
    сырого тела запроса, ключ — XROCKET_WEBHOOK_SECRET) указан по памяти —
    если xRocket реально считает подпись иначе, эта проверка будет всегда
    неуспешной и вебхуки будут отклоняться со статусом 403. В таком случае
    сверься с документацией и поправь только эту функцию."""
    if not signature or not XROCKET_WEBHOOK_SECRET:
        return False
    expected = hmac.new(
        XROCKET_WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


async def grant_product_purchase(
    user_id: int | None,
    product_id: str,
    duration_code: str,
    promo_field: str,
    amount_label: str,
    payment_id: str | None = None,
) -> None:
    """Списывает использование промокода (если был) и уведомляет
    пользователя о выдаче товара. Общая логика для оплаты звёздами
    (successful_payment_handler) и оплаты через xRocket (xrocket_webhook_handler)."""
    duration_label = DURATIONS.get(duration_code, {}).get("label", "")

    if promo_field and ":" in promo_field:
        promo_type, promo_key = promo_field.split(":", 1)
        if promo_type == "case" and promo_key in GENERATED_PROMOS:
            GENERATED_PROMOS[promo_key]["used"] = True
            _save_generated_promos()
        elif promo_type == "admin" and promo_key in ADMIN_PROMOS:
            ADMIN_PROMOS[promo_key]["activations"] += 1
            _save_admin_promos()

    if user_id is None:
        return

    # Выдаём ключ доступа: до этого места функция вызывается ТОЛЬКО после
    # 100% подтверждённой оплаты — звёздами (Telegram сам прислал
    # successful_payment) или через xRocket (подпись вебхука проверена,
    # статус "paid"). Ключ берётся из ACCESS_KEYS строго по очереди и
    # больше никогда никому не выдаётся повторно (issue_next_key
    # запоминает выданные ключи в ISSUED_KEYS).
    duration_text = f" на срок «{duration_label}»" if duration_label else ""
    key = await issue_next_key(user_id, product_id, duration_code, payment_id=payment_id)

    # Лог покупки — уходит только владельцу (ADMIN_ID = @meaninglessperson),
    # не второму владельцу и не назначенным админам. Юзернейм берём свежим
    # через get_chat, а не из старых данных, чтобы не показать неактуальный
    # username, если пользователь его сменил.
    try:
        buyer_chat = await bot.get_chat(user_id)
        buyer_label = f"@{buyer_chat.username}" if buyer_chat.username else f"id {user_id}"
    except Exception:
        buyer_label = f"id {user_id}"

    try:
        await bot.send_message(
            ADMIN_ID,
            f"🛒 Покупка\n"
            f"Покупатель: {buyer_label}\n"
            f"Тариф: {duration_label or duration_code}\n"
            f"Оплачено: {amount_label}",
        )
    except Exception:
        logging.exception("Не удалось отправить лог покупки владельцу")

    try:
        if key is not None:
            await bot.send_message(
                user_id,
                f"Оплата получена: {amount_label}\n"
                f"Товар «{product_id}»{duration_text} выдан. Спасибо за покупку!\n\n"
                f"Файл тут: {DELIVERY_FILE_LINK}\n"
                f"Ваш ключ: <code>{key}</code>",
                parse_mode="HTML",
            )
        else:
            # Ключи закончились — сообщаем и покупателю, и админу, чтобы
            # ключ выдали вручную и пополнили ACCESS_KEYS.
            await bot.send_message(
                user_id,
                f"Оплата получена: {amount_label}\n"
                f"Товар «{product_id}»{duration_text} оплачен, но свободные ключи "
                f"закончились. Мы выдадим ключ вручную в ближайшее время, "
                f"напишите, пожалуйста, в поддержку.",
            )
    except Exception:
        logging.exception("Не удалось отправить сообщение о выдаче товара пользователю %s", user_id)

    if key is None:
        try:
            await bot.send_message(
                ADMIN_ID,
                f"⚠️ Закончились ключи доступа! Покупатель {user_id} оплатил "
                f"«{product_id}»{duration_text} ({amount_label}), но свободного "
                f"ключа из ACCESS_KEYS не нашлось. Выдай ключ вручную и пополни список.",
            )
        except Exception:
            logging.exception("Не удалось уведомить админа о закончившихся ключах")


async def grant_case_reward(user_id: int | None, amount_label: str) -> None:
    """Крутит приз кейса, сохраняет промокод и кладёт его в
    PENDING_CASE_REWARDS. Общая логика для оплаты звёздами и xRocket."""
    if user_id is None:
        return

    discount_percent = roll_case_prize()
    code = generate_case_code()
    GENERATED_PROMOS[code.upper()] = {
        "code": code,
        "discount_percent": discount_percent,
        "used": False,
        "user_id": user_id,
    }
    _save_generated_promos()

    PENDING_CASE_REWARDS[str(user_id)] = {
        "code": code,
        "discount_percent": discount_percent,
    }
    _save_pending_case_rewards()

    try:
        await bot.send_message(
            user_id,
            f"Оплата получена: {amount_label}\n"
            f"Кейс открыт — выпал промокод «{code}» на скидку {discount_percent}%.\n"
            f"Он уже должен появиться в мини-аппе, а также сохранён в "
            f"«Профиль → Мои промокоды»."
        )
    except Exception:
        logging.exception("Не удалось отправить сообщение о призе кейса пользователю %s", user_id)


logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


# ====== Хендлеры бота ======

@dp.message(CommandStart())
async def start_handler(message: Message):
    username = message.from_user.username.lower() if message.from_user.username else None
    remember_user(message.from_user.id, username)
    if is_banned_and_backfill(message.from_user.id, username):
        await message.answer("🚫 Вы забанены и не можете пользоваться ботом.")
        return

    kb = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(
                text="Открыть магазин",
                web_app=WebAppInfo(url=WEBAPP_URL),
            )
        ]]
    )
    await message.answer(
        "Добро пожаловать! Нажми кнопку ниже, чтобы открыть магазин.",
        reply_markup=kb,
    )


@dp.pre_checkout_query()
async def pre_checkout_handler(pre_checkout_query: PreCheckoutQuery):
    # Тут можно проверить наличие товара/остатки и т.д.
    # Обязательно ответить в течение 10 секунд, иначе оплата сорвётся.
    await bot.answer_pre_checkout_query(pre_checkout_query.id, ok=True)


@dp.message(F.successful_payment)
async def successful_payment_handler(message: Message):
    payment = message.successful_payment
    # payload теперь в формате "product_id:duration_code:promo_key",
    # например "dystopia:30d:KICHIRO-A1B2C" (promo_key пустой, если
    # промокод не применялся или был статическим).
    raw_payload = payment.invoice_payload
    parts = raw_payload.split(":")
    product_id = parts[0] if len(parts) > 0 else ""
    duration_code = parts[1] if len(parts) > 1 else ""
    promo_field = parts[2] if len(parts) > 2 else ""

    # Открытие платного кейса — отдельная ветка: тут не выдаётся доступ к
    # товару на срок, а "крутится" приз (см. roll_case_prize) и кладётся в
    # PENDING_CASE_REWARDS, откуда его тут же заберёт мини-апп через
    # POST /claim_case_reward.
    amount_label = f"{payment.total_amount} ★"

    if product_id == "case_open":
        await grant_case_reward(message.from_user.id, amount_label)
        return

    # promo_field теперь в формате "тип:ключ" (например "case:KICHIRO-A1B2C"
    # или "admin:SALE50"), либо пустой, если промокод не применялся или был
    # статическим. Списываем использование только теперь, когда оплата
    # реально прошла (а не просто была создана ссылка на инвойс).
    await grant_product_purchase(
        message.from_user.id,
        product_id,
        duration_code,
        promo_field,
        amount_label,
        payment_id=payment.telegram_payment_charge_id,
    )


# ====== HTTP-эндпоинт для мини-аппа ======

async def create_invoice_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    product_id = data.get("product_id")
    duration_code = data.get("duration", "7d")
    promo_code_raw = data.get("promo_code")

    # Дополнительная защита: даже если забаненный пользователь как-то
    # обошёл проверку /check_ban на фронтенде, инвойс всё равно не
    # создастся.
    ban_user_id, ban_username = resolve_user(data.get("init_data"))
    if is_banned_and_backfill(ban_user_id, ban_username):
        return web.json_response({"error": "banned"}, status=403)

    product = PRODUCTS.get(product_id)
    duration = DURATIONS.get(duration_code)

    if not product:
        return web.json_response({"error": "unknown product"}, status=404)
    if not duration:
        return web.json_response({"error": "unknown duration"}, status=404)
    if not duration.get("available", True):
        return web.json_response({"error": "duration unavailable"}, status=409)
    if not has_available_key(product_id, duration_code):
        return web.json_response({"error": "out_of_stock"}, status=409)

    # ВАЖНО: цену считаем только на бэкенде, по своей таблице цен и
    # промокодов. Клиенту нельзя доверять — он не присылает готовую цену,
    # только код промокода, а сумма всегда пересчитывается здесь.
    base_price = duration["price"]
    final_price, promo = apply_promo(base_price, promo_code_raw)

    promo_applied = promo is not None
    # Если промокод был передан, но не найден/уже использован — сообщаем
    # об этом клиенту, но всё равно создаём инвойс по полной цене, чтобы
    # не блокировать покупку.
    promo_invalid = bool(promo_code_raw) and not promo_applied

    title = product["title"]
    description = f"{product['description']} — доступ на {duration['label']}"
    if promo_applied:
        description += f" (промокод -{promo['discount_percent']}%)"

    # Для одноразовых кейсовых и многоразовых админских промокодов кладём
    # "тип:ключ" в payload — так бот сможет списать использование именно в
    # момент успешной оплаты (successful_payment_handler), а не раньше,
    # чтобы отменённая или неудавшаяся оплата не "сжигала" код впустую.
    promo_key_for_payload = ""
    if promo_applied and promo.get("type") in ("case", "admin"):
        promo_key_for_payload = f"{promo['type']}:{promo['key']}"
    payload = f"{product_id}:{duration_code}:{promo_key_for_payload}"  # вернётся в successful_payment.invoice_payload

    invoice_link = await bot.create_invoice_link(
        title=title,
        description=description,
        payload=payload,
        provider_token="",           # для звёзд (XTR) всегда пустая строка
        currency="XTR",
        prices=[LabeledPrice(label=title, amount=final_price)],
    )

    return web.json_response({
        "invoice_link": invoice_link,
        "base_price": base_price,
        "final_price": final_price,
        "promo_applied": promo_applied,
        "promo_invalid": promo_invalid,
        "discount_percent": promo["discount_percent"] if promo_applied else 0,
    })


# ====== xRocket Pay: покупка товара ======

async def create_invoice_xrocket_handler(request: web.Request) -> web.Response:
    """Создаёт счёт в xRocket Pay на покупку товара (аналог
    create_invoice_handler, но для оплаты криптой вместо звёзд).

    Оплата подтверждается асинхронно через POST /xrocket_webhook, поэтому
    тут же сохраняем в XROCKET_INVOICES, что именно куплено и кем, — по
    id счёта из ответа xRocket."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    product_id = data.get("product_id")
    duration_code = data.get("duration", "7d")
    promo_code_raw = data.get("promo_code")

    user_id, ban_username = resolve_user(data.get("init_data"))
    if is_banned_and_backfill(user_id, ban_username):
        return web.json_response({"error": "banned"}, status=403)
    if user_id is None:
        return web.json_response({"error": "no init_data"}, status=400)

    product = PRODUCTS.get(product_id)
    duration = DURATIONS.get(duration_code)
    base_price = XROCKET_PRICES.get(duration_code)

    if not product:
        return web.json_response({"error": "unknown product"}, status=404)
    if not duration or base_price is None:
        return web.json_response({"error": "unknown duration"}, status=404)
    if not duration.get("available", True):
        return web.json_response({"error": "duration unavailable"}, status=409)
    if not has_available_key(product_id, duration_code):
        return web.json_response({"error": "out_of_stock"}, status=409)

    final_price, promo = apply_promo_float(base_price, promo_code_raw)
    promo_applied = promo is not None
    promo_invalid = bool(promo_code_raw) and not promo_applied

    promo_field = ""
    if promo_applied and promo.get("type") in ("case", "admin"):
        promo_field = f"{promo['type']}:{promo['key']}"

    title = product["title"]
    description = f"{product['description']} — доступ на {duration['label']}"
    if promo_applied:
        description += f" (промокод -{promo['discount_percent']}%)"

    try:
        result = await xrocket_request(
            "POST",
            "/tg-invoices",
            {
                "amount": final_price,
                "currency": XROCKET_CURRENCY,
                "description": description,
                "payload": f"{product_id}:{duration_code}",
                "callbackUrl": f"{WEBAPP_URL.rstrip('/')}/xrocket_webhook",
                "commentsEnabled": False,
                "expiredIn": 1800,  # 30 минут на оплату счёта
            },
        )
    except Exception:
        logging.exception("Не удалось создать счёт xRocket")
        return web.json_response({"error": "xrocket_unavailable"}, status=502)

    invoice_data = result.get("data", result)
    invoice_id = str(invoice_data.get("id"))
    invoice_link = invoice_data.get("link")

    if not invoice_id or not invoice_link:
        logging.error("Неожиданный ответ xRocket при создании счёта: %s", result)
        return web.json_response({"error": "xrocket_bad_response"}, status=502)

    XROCKET_INVOICES[invoice_id] = {
        "kind": "product",
        "user_id": user_id,
        "product_id": product_id,
        "duration_code": duration_code,
        "promo_field": promo_field,
        "amount": final_price,
        "status": "pending",
        "created": time.time(),
    }
    _save_xrocket_invoices()

    return web.json_response({
        "invoice_id": invoice_id,
        "invoice_link": invoice_link,
        "base_price": base_price,
        "final_price": final_price,
        "promo_applied": promo_applied,
        "promo_invalid": promo_invalid,
        "discount_percent": promo["discount_percent"] if promo_applied else 0,
        "currency": XROCKET_CURRENCY,
    })


async def create_case_invoice_xrocket_handler(request: web.Request) -> web.Response:
    """Аналог create_case_invoice_handler, но открытие кейса оплачивается
    через xRocket Pay вместо звёзд."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    user_id, ban_username = resolve_user(data.get("init_data"))
    if is_banned_and_backfill(user_id, ban_username):
        return web.json_response({"error": "banned"}, status=403)
    if user_id is None:
        return web.json_response({"error": "no init_data"}, status=400)

    try:
        result = await xrocket_request(
            "POST",
            "/tg-invoices",
            {
                "amount": XROCKET_CASE_PRICE,
                "currency": XROCKET_CURRENCY,
                "description": "Открытие кейса — случайный промокод на скидку от 3% до 50%.",
                "payload": "case_open",
                "callbackUrl": f"{WEBAPP_URL.rstrip('/')}/xrocket_webhook",
                "commentsEnabled": False,
                "expiredIn": 1800,
            },
        )
    except Exception:
        logging.exception("Не удалось создать счёт xRocket для кейса")
        return web.json_response({"error": "xrocket_unavailable"}, status=502)

    invoice_data = result.get("data", result)
    invoice_id = str(invoice_data.get("id"))
    invoice_link = invoice_data.get("link")

    if not invoice_id or not invoice_link:
        logging.error("Неожиданный ответ xRocket при создании счёта кейса: %s", result)
        return web.json_response({"error": "xrocket_bad_response"}, status=502)

    XROCKET_INVOICES[invoice_id] = {
        "kind": "case",
        "user_id": user_id,
        "product_id": "",
        "duration_code": "",
        "promo_field": "",
        "amount": XROCKET_CASE_PRICE,
        "status": "pending",
        "created": time.time(),
    }
    _save_xrocket_invoices()

    return web.json_response({
        "invoice_id": invoice_id,
        "invoice_link": invoice_link,
        "price": XROCKET_CASE_PRICE,
        "currency": XROCKET_CURRENCY,
    })


async def xrocket_webhook_handler(request: web.Request) -> web.Response:
    """Принимает уведомление об оплате от xRocket Pay (callbackUrl).

    ВНИМАНИЕ: точный формат тела вебхука ("invoiceId"/"status" и т.п.) и
    заголовок подписи собраны по памяти — см. комментарий у
    verify_xrocket_signature. Если xRocket шлёт другие имена полей, здесь
    достаточно поправить извлечение invoice_id/status ниже."""
    raw_body = await request.read()
    signature = request.headers.get("Rocket-Pay-Signature") or request.headers.get("X-Signature")

    if not verify_xrocket_signature(raw_body, signature):
        logging.warning("xRocket webhook: неверная или отсутствующая подпись")
        return web.json_response({"error": "bad signature"}, status=403)

    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return web.json_response({"error": "bad json"}, status=400)

    payload_data = body.get("data", body)
    invoice_id = str(payload_data.get("id") or payload_data.get("invoiceId") or "")
    status = str(payload_data.get("status") or payload_data.get("paymentStatus") or "").lower()

    entry = XROCKET_INVOICES.get(invoice_id)
    if entry is None:
        logging.warning("xRocket webhook: неизвестный счёт %s", invoice_id)
        return web.json_response({"ok": True})  # отвечаем 200, чтобы xRocket не повторял бесконечно

    if entry["status"] == "paid":
        return web.json_response({"ok": True})  # уже обработан — не выдаём повторно

    if status not in ("paid", "success", "completed"):
        return web.json_response({"ok": True})

    entry["status"] = "paid"
    _save_xrocket_invoices()

    amount_label = f"{entry['amount']} {XROCKET_CURRENCY}"
    user_id = entry.get("user_id")

    if entry["kind"] == "case":
        await grant_case_reward(user_id, amount_label)
    else:
        await grant_product_purchase(
            user_id,
            entry["product_id"],
            entry["duration_code"],
            entry["promo_field"],
            amount_label,
            payment_id=f"xrocket:{invoice_id}",
        )

    return web.json_response({"ok": True})


async def xrocket_invoice_status_handler(request: web.Request) -> web.Response:
    """Опрашивается фронтендом (мини-аппом), пока открыта страница оплаты
    xRocket — так же, как tg.openInvoice даёт колбэк для звёзд. Основной
    источник истины — вебхук выше; эта ручка просто отдаёт, что уже
    записано в XROCKET_INVOICES."""
    invoice_id = request.query.get("invoice_id", "")
    entry = XROCKET_INVOICES.get(invoice_id)
    if entry is None:
        return web.json_response({"error": "not found"}, status=404)

    return web.json_response({"status": entry["status"]})


async def open_case_handler(request: web.Request) -> web.Response:
    """Старая ручка бесплатного открытия кейса — оставлена только на
    случай, если CASE_IS_FREE снова включат вручную. Пока кейс платный
    (CASE_IS_FREE = False), фронтенд должен использовать
    POST /create_case_invoice + POST /claim_case_reward."""
    if not CASE_IS_FREE:
        return web.json_response(
            {"error": "case is not free, use /create_case_invoice"}, status=400
        )

    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id, username = resolve_user(body.get("init_data"))
    if is_banned_and_backfill(user_id, username):
        return web.json_response({"error": "banned"}, status=403)

    discount_percent = roll_case_prize()
    code = generate_case_code()
    GENERATED_PROMOS[code.upper()] = {
        "code": code,
        "discount_percent": discount_percent,
        "used": False,
        "user_id": user_id,
    }
    _save_generated_promos()

    return web.json_response({
        "code": code,
        "discount_percent": discount_percent,
        "is_free": CASE_IS_FREE,
    })


async def create_case_invoice_handler(request: web.Request) -> web.Response:
    """Создаёт инвойс на CASE_PRICE_STARS звёзд для открытия кейса.

    Сам приз не выбирается здесь — он "крутится" только в момент
    подтверждённой оплаты, в successful_payment_handler (payload
    "case_open::"), и кладётся в PENDING_CASE_REWARDS."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    ban_user_id, ban_username = resolve_user(data.get("init_data"))
    if is_banned_and_backfill(ban_user_id, ban_username):
        return web.json_response({"error": "banned"}, status=403)

    invoice_link = await bot.create_invoice_link(
        title="Кейс с промокодом",
        description=f"Открытие кейса — случайный промокод на скидку от 3% до 50%.",
        payload="case_open::",
        provider_token="",
        currency="XTR",
        prices=[LabeledPrice(label="Открытие кейса", amount=CASE_PRICE_STARS)],
    )

    return web.json_response({
        "invoice_link": invoice_link,
        "price": CASE_PRICE_STARS,
    })


async def claim_case_reward_handler(request: web.Request) -> web.Response:
    """Забирает приз кейса, если оплата уже прошла и successful_payment_handler
    успел его "прокрутить". Фронтенд опрашивает эту ручку короткими
    интервалами сразу после того, как tg.openInvoice сообщил статус
    "paid". Приз отдаётся один раз — как только он забран, запись
    удаляется."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = resolve_user_id(body.get("init_data"))
    if user_id is None:
        return web.json_response({"ready": False})

    reward = PENDING_CASE_REWARDS.pop(str(user_id), None)
    if reward is None:
        return web.json_response({"ready": False})

    _save_pending_case_rewards()
    return web.json_response({
        "ready": True,
        "code": reward["code"],
        "discount_percent": reward["discount_percent"],
    })


async def my_promo_codes_handler(request: web.Request) -> web.Response:
    """Отдаёт список неиспользованных кейсовых промокодов текущего
    пользователя — используется экраном "Мои промокоды" в профиле.

    user_id достаётся только из подписанного initData, поэтому один
    пользователь не может запросить чужие коды, подставив произвольный id.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = resolve_user_id(body.get("init_data"))
    if user_id is None:
        return web.json_response({"codes": []})

    codes = [
        {"code": promo["code"], "discount_percent": promo["discount_percent"]}
        for promo in GENERATED_PROMOS.values()
        if promo.get("user_id") == user_id and not promo["used"]
    ]
    # Самые свежие коды — сверху (порядок вставки в словаре сохраняется).
    codes.reverse()

    return web.json_response({"codes": codes})


async def delete_promo_codes_handler(request: web.Request) -> web.Response:
    """Удаляет выбранные пользователем кейсовые промокоды (мультивыбор
    в "Моих промокодах"). Удалить можно только свои и только
    неиспользованные коды — код чужого пользователя или уже
    использованный просто игнорируется.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = resolve_user_id(body.get("init_data"))
    raw_codes = body.get("codes")
    if user_id is None or not isinstance(raw_codes, list):
        return web.json_response({"deleted": []})

    deleted = []
    for raw_code in raw_codes:
        key = str(raw_code).strip().upper()
        promo = GENERATED_PROMOS.get(key)
        if promo and promo.get("user_id") == user_id and not promo["used"]:
            del GENERATED_PROMOS[key]
            deleted.append(key)

    if deleted:
        _save_generated_promos()

    return web.json_response({"deleted": deleted})


async def delete_all_promo_codes_handler(request: web.Request) -> web.Response:
    """Удаляет ВСЕ неиспользованные кейсовые промокоды текущего
    пользователя — кнопка "Удалить все" в "Моих промокодах"."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = resolve_user_id(body.get("init_data"))
    if user_id is None:
        return web.json_response({"deleted": []})

    deleted = [
        key
        for key, promo in GENERATED_PROMOS.items()
        if promo.get("user_id") == user_id and not promo["used"]
    ]
    for key in deleted:
        del GENERATED_PROMOS[key]

    if deleted:
        _save_generated_promos()

    return web.json_response({"deleted": deleted})


async def validate_promo_handler(request: web.Request) -> web.Response:
    """Позволяет фронтенду проверить промокод (в т.ч. кейсовый) до покупки,
    не создавая инвойс — используется на экране оформления при нажатии
    «Применить»."""
    code = request.query.get("code", "")
    discount_percent, promo = resolve_promo(code)

    return web.json_response({
        "valid": promo is not None,
        "discount_percent": discount_percent if promo else 0,
    })


async def stock_status_handler(request: web.Request) -> web.Response:
    """Отдаёт фронтенду, остались ли ещё свободные ключи доступа для
    конкретного товара. Дёргается при открытии экрана оформления (см.
    checkStockStatus в script.js), чтобы показать "Нет в наличии", если
    все ключи уже раскуплены (или админ вручную выключил наличие) — ещё
    до попытки оплаты."""
    product_id = request.query.get("product_id", "dystopia")
    return web.json_response({"available": has_available_key(product_id)})


async def check_ban_handler(request: web.Request) -> web.Response:
    """Проверяет, забанен ли текущий пользователь мини-аппа. Фронтенд
    дёргает этот эндпоинт при каждом открытии, до того как показать сам
    интерфейс — если пользователь забанен, вместо загрузки показывается
    экран "Вы забанены"."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id, username = resolve_user(body.get("init_data"))
    return web.json_response({"banned": is_banned_and_backfill(user_id, username)})


async def admin_ban_handler(request: web.Request) -> web.Response:
    """Банит пользователя по username или id. Доступно только ADMIN_ID —
    право проверяется по подписанному initData, а не по тому, что прислал
    клиент."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_target = str(body.get("target", "")).strip()
    if not raw_target:
        return web.json_response({"error": "empty target"}, status=400)

    target_id, target_username = _parse_ban_target(raw_target)
    if target_id is None and not target_username:
        return web.json_response({"error": "bad target"}, status=400)

    # Не даём забанить кого-то из владельцев.
    if is_owner_user(target_id, target_username):
        return web.json_response({"error": "cannot ban admin"}, status=400)

    existing_key = _find_ban_entry(target_id, target_username)
    if existing_key:
        return web.json_response({"error": "already banned"}, status=409)

    key = f"ban_{len(BANNED_USERS) + 1}_{random.randint(1000, 9999)}"
    BANNED_USERS[key] = {"user_id": target_id, "username": target_username}
    _save_banned_users()

    return web.json_response({"banned": BANNED_USERS[key]})


async def admin_unban_handler(request: web.Request) -> web.Response:
    """Разбанивает пользователя. Принимает либо ключ записи ("key"),
    либо тот же target (username/id), что и при бане."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    key = body.get("key")
    if not key:
        raw_target = str(body.get("target", "")).strip()
        target_id, target_username = _parse_ban_target(raw_target)
        key = _find_ban_entry(target_id, target_username)

    if key and key in BANNED_USERS:
        del BANNED_USERS[key]
        _save_banned_users()
        return web.json_response({"unbanned": key})

    return web.json_response({"error": "not found"}, status=404)


async def admin_banned_list_handler(request: web.Request) -> web.Response:
    """Отдаёт список всех забаненных пользователей — для списка в
    админ-панели."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    items = [{"key": key, **entry} for key, entry in BANNED_USERS.items()]
    items.reverse()
    return web.json_response({"banned": items})


async def admin_promo_create_handler(request: web.Request) -> web.Response:
    """Создаёт многоразовый промокод с произвольным названием, скидкой и
    лимитом активаций. Доступно только ADMIN_ID."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_code = str(body.get("code", "")).strip()
    if not raw_code:
        return web.json_response({"error": "empty code"}, status=400)

    try:
        discount_percent = int(body.get("discount_percent"))
    except (TypeError, ValueError):
        return web.json_response({"error": "bad discount"}, status=400)
    if not 1 <= discount_percent <= 100:
        return web.json_response({"error": "discount out of range"}, status=400)

    try:
        max_activations = int(body.get("max_activations"))
    except (TypeError, ValueError):
        return web.json_response({"error": "bad max_activations"}, status=400)
    if max_activations < 1:
        return web.json_response({"error": "max_activations out of range"}, status=400)

    key = raw_code.upper()
    if key in ADMIN_PROMOS or key in GENERATED_PROMOS or raw_code.lower() in PROMO_CODES:
        return web.json_response({"error": "code already exists"}, status=409)

    ADMIN_PROMOS[key] = {
        "code": raw_code,
        "discount_percent": discount_percent,
        "max_activations": max_activations,
        "activations": 0,
    }
    _save_admin_promos()

    return web.json_response({"promo": ADMIN_PROMOS[key]})


async def admin_promo_delete_handler(request: web.Request) -> web.Response:
    """Удаляет промокод, созданный из админ-панели."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_code = str(body.get("code", "")).strip()
    key = raw_code.upper()

    if key in ADMIN_PROMOS:
        del ADMIN_PROMOS[key]
        _save_admin_promos()
        return web.json_response({"deleted": key})

    return web.json_response({"error": "not found"}, status=404)


async def admin_promo_list_handler(request: web.Request) -> web.Response:
    """Отдаёт список всех промокодов, созданных из админ-панели."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    items = list(ADMIN_PROMOS.values())
    items.reverse()
    return web.json_response({"promos": items})


async def admin_keys_add_handler(request: web.Request) -> web.Response:
    """Добавляет один новый ключ доступа в EXTRA_ACCESS_KEYS (в рантайме,
    без деплоя), привязанный к выбранному сроку (duration_code — один из
    DURATIONS, по умолчанию "7d"). Доступно любому назначенному
    админу/владельцу."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_key = str(body.get("key", "")).strip()
    if not raw_key:
        return web.json_response({"error": "empty key"}, status=400)

    duration_code = str(body.get("duration_code", "7d")).strip() or "7d"
    if duration_code not in DURATIONS:
        return web.json_response({"error": "unknown duration"}, status=400)

    if raw_key in ACCESS_KEYS or raw_key in _extra_key_strings():
        return web.json_response({"error": "key already exists"}, status=409)

    EXTRA_ACCESS_KEYS.append({"key": raw_key, "duration_code": duration_code})
    _save_extra_access_keys()

    # Если раньше товар был вручную переключён в "нет в наличии" (например,
    # когда закончились ключи) — теперь, когда добавлен новый ключ, снимаем
    # этот ручной оверрайд, чтобы наличие снова считалось автоматически по
    # реальному остатку ключей. Без этого добавленный ключ не выдавался бы:
    # STOCK_OVERRIDE=False всегда главнее фактического наличия ключей (см.
    # has_available_key).
    product_id = str(body.get("product_id", "dystopia"))
    if STOCK_OVERRIDE.get(product_id) is False:
        STOCK_OVERRIDE.pop(product_id, None)
        _save_stock_override()

    return web.json_response({
        "key": raw_key,
        "duration_code": duration_code,
        "total": len(all_access_keys()),
        "stock_override": STOCK_OVERRIDE.get(product_id),
        "effective_available": has_available_key(product_id, duration_code),
    })


async def admin_keys_clear_issued_handler(request: web.Request) -> web.Response:
    """Чистит "мусорные" записи в ISSUED_KEYS — то есть записи о выдаче
    ключей, которых уже нет ни в ACCESS_KEYS, ни в EXTRA_ACCESS_KEYS
    (например, старые ключи, удалённые из кода вручную, как в этот раз).

    НЕ трогает записи о ключах, которые всё ещё числятся в текущем списке
    (ACCESS_KEYS/EXTRA_ACCESS_KEYS) — такие ключи остаются выданными и не
    освобождаются, чтобы их нельзя было случайно выдать повторно другому
    покупателю. Это просто уборка "хвостов" от уже удалённых ключей, если
    они мешаются/накапливаются в хранилище."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    active_keys = set(all_access_keys())
    stale_keys = [key for key in ISSUED_KEYS if key not in active_keys]

    for key in stale_keys:
        del ISSUED_KEYS[key]
    if stale_keys:
        _save_issued_keys()

    return web.json_response({"cleared": stale_keys, "cleared_count": len(stale_keys)})


async def admin_keys_delete_handler(request: web.Request) -> web.Response:
    """Удаляет ключ, добавленный через админ-панель (EXTRA_ACCESS_KEYS).
    Ключи, зашитые в код (ACCESS_KEYS), а также уже выданные покупателям —
    удалить нельзя."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_key = str(body.get("key", "")).strip()

    if raw_key in ACCESS_KEYS:
        return web.json_response({"error": "cannot delete built-in key"}, status=403)
    if raw_key not in _extra_key_strings():
        return web.json_response({"error": "not found"}, status=404)
    if raw_key in ISSUED_KEYS:
        return web.json_response({"error": "key already issued"}, status=409)

    EXTRA_ACCESS_KEYS[:] = [item for item in EXTRA_ACCESS_KEYS if item["key"] != raw_key]
    _save_extra_access_keys()

    return web.json_response({"deleted": raw_key, "total": len(all_access_keys())})


async def admin_keys_list_handler(request: web.Request) -> web.Response:
    """Отдаёт список всех ключей (и зашитых в код, и добавленных из
    админ-панели) с пометкой, выдан ли уже каждый из них, на какой срок
    ключ выдан (duration_code/duration_label) и можно ли его удалить,
    плюс текущее состояние ручного переключателя "в наличии". Если в теле
    запроса передан filter_duration_code — возвращает только ключи этого
    срока."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    product_id = str(body.get("product_id", "dystopia"))
    filter_duration_code = body.get("filter_duration_code") or None

    items = []
    for key in all_access_keys(filter_duration_code):
        issued = ISSUED_KEYS.get(key)
        duration_code = key_duration_code(key)
        items.append({
            "key": key,
            "duration_code": duration_code,
            "duration_label": DURATIONS.get(duration_code, {}).get("label", duration_code),
            "issued": issued is not None,
            "issued_at": issued.get("issued_at") if issued else None,
            "deletable": key in _extra_key_strings() and issued is None,
        })

    return web.json_response({
        "keys": items,
        "available_count": sum(1 for item in items if not item["issued"]),
        "stock_override": STOCK_OVERRIDE.get(product_id),
        "durations": [
            {"code": code, "label": info["label"]} for code, info in DURATIONS.items()
        ],
    })


async def admin_keys_set_stock_handler(request: web.Request) -> web.Response:
    """Устанавливает (или снимает) ручной переключатель "в наличии" для
    товара. available: true — принудительно "в наличии", false —
    принудительно "нет в наличии", null/отсутствует — вернуться к
    автоматическому подсчёту по реальному остатку ключей."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    product_id = str(body.get("product_id", "dystopia"))
    raw_available = body.get("available")

    if raw_available is None:
        STOCK_OVERRIDE.pop(product_id, None)
    elif isinstance(raw_available, bool):
        STOCK_OVERRIDE[product_id] = raw_available
    else:
        return web.json_response({"error": "bad available"}, status=400)

    _save_stock_override()

    return web.json_response({
        "product_id": product_id,
        "stock_override": STOCK_OVERRIDE.get(product_id),
        "effective_available": has_available_key(product_id),
    })


async def admin_user_promo_codes_handler(request: web.Request) -> web.Response:
    """Отдаёт ВСЕ одноразовые кейсовые промокоды (GENERATED_PROMOS) любого
    пользователя — по его username или числовому id. В отличие от
    /my_promo_codes (который отдаёт только свои и только неиспользованные
    коды текущего пользователя), эта ручка доступна админу для ЛЮБОГО
    пользователя и отдаёт коды независимо от статуса "использован".

    Если ввели username, а не id, пользователь ищется через
    USER_DIRECTORY (заполняется автоматически при любом открытии мини-аппа
    этим человеком) — если он никогда не открывал бота/мини-апп, найти его
    коды по username невозможно (и вернётся ошибка "user_not_found)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_target = str(body.get("target", "")).strip()
    if not raw_target:
        return web.json_response({"error": "empty target"}, status=400)

    target_id, target_username = _resolve_target_user(raw_target)
    if target_id is None and not target_username:
        return web.json_response({"error": "bad target"}, status=400)
    if target_id is None:
        # username есть, но ни разу не встречался в USER_DIRECTORY —
        # значит, найти его промокоды нечем.
        return web.json_response({"error": "user_not_found"}, status=404)

    directory_entry = USER_DIRECTORY.get(str(target_id), {})
    resolved_username = directory_entry.get("username") or target_username

    codes = [
        {
            "code": promo["code"],
            "discount_percent": promo["discount_percent"],
            "used": bool(promo.get("used")),
        }
        for promo in GENERATED_PROMOS.values()
        if promo.get("user_id") == target_id
    ]
    codes.reverse()

    return web.json_response({
        "codes": codes,
        "user_id": target_id,
        "username": resolved_username,
    })


async def admin_user_promo_delete_handler(request: web.Request) -> web.Response:
    """Удаляет ЛЮБОЙ одноразовый кейсовый промокод по коду — независимо от
    того, кому он принадлежит и использован ли он. Это отличает её от
    /delete_promo_codes (доступна только владельцу кода и только для
    неиспользованных). Доступно владельцу и назначенным админам."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_admin_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_code = str(body.get("code", "")).strip()
    key = raw_code.upper()

    if key in GENERATED_PROMOS:
        del GENERATED_PROMOS[key]
        _save_generated_promos()
        return web.json_response({"deleted": key})

    return web.json_response({"error": "not found"}, status=404)


async def admin_whoami_handler(request: web.Request) -> web.Response:
    """Отдаёт права текущего пользователя: is_admin (владелец или
    назначенный админ — видит вкладку "Админ-панель") и is_owner (только
    ADMIN_ID — видит блок управления админами)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id, username = resolve_user(body.get("init_data"))
    is_owner = is_owner_user(user_id, username)
    is_admin = is_owner or is_assigned_admin(user_id, username)

    return web.json_response({"is_admin": is_admin, "is_owner": is_owner})


async def admin_admins_list_handler(request: web.Request) -> web.Response:
    """Отдаёт список назначенных админов. Доступно только владельцу."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_owner_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    items = [{"key": key, **entry} for key, entry in ADMINS.items()]
    items.reverse()
    return web.json_response({"admins": items})


async def admin_admins_add_handler(request: web.Request) -> web.Response:
    """Назначает пользователя админом по username или id. Доступно только
    владельцу (ADMIN_ID)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_owner_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    raw_target = str(body.get("target", "")).strip()
    if not raw_target:
        return web.json_response({"error": "empty target"}, status=400)

    target_id, target_username = _parse_ban_target(raw_target)
    if target_id is None and not target_username:
        return web.json_response({"error": "bad target"}, status=400)

    # Владельцы и так всегда админы — не даём добавить кого-то из них в
    # список ещё раз.
    if is_owner_user(target_id, target_username):
        return web.json_response({"error": "already owner"}, status=400)

    existing_key = _find_admin_entry(target_id, target_username)
    if existing_key:
        return web.json_response({"error": "already admin"}, status=409)

    key = f"adm_{len(ADMINS) + 1}_{random.randint(1000, 9999)}"
    ADMINS[key] = {"user_id": target_id, "username": target_username}
    _save_admins()

    return web.json_response({"admin": ADMINS[key]})


async def admin_admins_remove_handler(request: web.Request) -> web.Response:
    """Снимает права админа. Принимает либо ключ записи ("key"), либо
    target (username/id). Доступно только владельцу (ADMIN_ID)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not is_owner_init_data(body.get("init_data")):
        return web.json_response({"error": "forbidden"}, status=403)

    key = body.get("key")
    if not key:
        raw_target = str(body.get("target", "")).strip()
        target_id, target_username = _parse_ban_target(raw_target)
        key = _find_admin_entry(target_id, target_username)

    if key and key in ADMINS:
        del ADMINS[key]
        _save_admins()
        return web.json_response({"removed": key})

    return web.json_response({"error": "not found"}, status=404)


async def avatar_handler(request: web.Request) -> web.Response:
    """Отдаёт аватар пользователя картинкой.

    Telegram Mini Apps не всегда передают photo_url в initData (из
    соображений приватности), поэтому фронтенд запрашивает фото у бота
    напрямую через этот эндпоинт: бот дёргает getUserProfilePhotos и
    отдаёт файл как обычную картинку.
    """
    user_id_raw = request.query.get("user_id")

    if not user_id_raw or not user_id_raw.isdigit():
        return web.Response(status=400)

    user_id = int(user_id_raw)

    try:
        photos = await bot.get_user_profile_photos(user_id, limit=1)
        if photos.total_count == 0 or not photos.photos:
            return web.Response(status=404)

        # Берём самый большой размер последнего доступного фото
        file_id = photos.photos[0][-1].file_id
        file_info = await bot.get_file(file_id)
        file_bytes = await bot.download_file(file_info.file_path)

        return web.Response(
            body=file_bytes.read(),
            content_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception:
        logging.exception("Не удалось получить аватар пользователя %s", user_id)
        return web.Response(status=404)


async def index_handler(request: web.Request) -> web.Response:
    return web.FileResponse("static/index.html")


@web.middleware
async def no_cache_static_middleware(request: web.Request, handler):
    """Запрещает кешировать script.js/style.css/index.html.

    Telegram Mini App живёт внутри WebView, который умеет агрессивно
    кешировать статику по URL. Если после деплоя обновлённого кода клиент
    получает из кеша старую версию JS/CSS (а HTML — уже новую, или
    наоборот), интерфейс может выглядеть "битым" при повторном открытии —
    именно это похоже на баг "открывается через раз". Явно запрещаем кеш
    для этих файлов, чтобы каждое открытие мини-аппа гарантированно тянуло
    актуальную версию.
    """
    response = await handler(request)
    if request.path in ("/", "/index.html", "/script.js", "/style.css"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


def build_web_app() -> web.Application:
    app = web.Application(middlewares=[no_cache_static_middleware])
    app.router.add_post("/create_invoice", create_invoice_handler)
    app.router.add_post("/create_invoice_xrocket", create_invoice_xrocket_handler)
    app.router.add_post("/create_case_invoice_xrocket", create_case_invoice_xrocket_handler)
    app.router.add_post("/xrocket_webhook", xrocket_webhook_handler)
    app.router.add_get("/xrocket_invoice_status", xrocket_invoice_status_handler)
    app.router.add_post("/open_case", open_case_handler)
    app.router.add_post("/create_case_invoice", create_case_invoice_handler)
    app.router.add_post("/claim_case_reward", claim_case_reward_handler)
    app.router.add_post("/my_promo_codes", my_promo_codes_handler)
    app.router.add_post("/delete_promo_codes", delete_promo_codes_handler)
    app.router.add_post("/delete_all_promo_codes", delete_all_promo_codes_handler)
    app.router.add_get("/validate_promo", validate_promo_handler)
    app.router.add_get("/stock_status", stock_status_handler)
    app.router.add_post("/check_ban", check_ban_handler)
    app.router.add_post("/admin/ban", admin_ban_handler)
    app.router.add_post("/admin/unban", admin_unban_handler)
    app.router.add_post("/admin/banned_list", admin_banned_list_handler)
    app.router.add_post("/admin/promo/create", admin_promo_create_handler)
    app.router.add_post("/admin/promo/delete", admin_promo_delete_handler)
    app.router.add_post("/admin/promo/list", admin_promo_list_handler)
    app.router.add_post("/admin/keys/add", admin_keys_add_handler)
    app.router.add_post("/admin/keys/delete", admin_keys_delete_handler)
    app.router.add_post("/admin/keys/clear_issued", admin_keys_clear_issued_handler)
    app.router.add_post("/admin/keys/list", admin_keys_list_handler)
    app.router.add_post("/admin/keys/set_stock", admin_keys_set_stock_handler)
    app.router.add_post("/admin/user_promo_codes", admin_user_promo_codes_handler)
    app.router.add_post("/admin/user_promo_delete", admin_user_promo_delete_handler)
    app.router.add_post("/admin/whoami", admin_whoami_handler)
    app.router.add_post("/admin/admins/list", admin_admins_list_handler)
    app.router.add_post("/admin/admins/add", admin_admins_add_handler)
    app.router.add_post("/admin/admins/remove", admin_admins_remove_handler)
    app.router.add_get("/avatar", avatar_handler)
    app.router.add_get("/", index_handler)
    # Раздаём фронтенд (style.css, script.js) с того же домена.
    # CORS больше не нужен — всё работает на одном origin.
    app.router.add_static("/", path="static", show_index=False)
    return app


async def run_web_server():
    app = build_web_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()
    logging.info(f"HTTP-сервер запущен на http://{HOST}:{PORT}")


async def main():
    # На случай, если ранее был установлен webhook (через BotFather,
    # другой скрипт, или предыдущий запуск с set_webhook) — сбрасываем его,
    # иначе getUpdates (polling) будет конфликтовать с webhook'ом.
    await bot.delete_webhook(drop_pending_updates=True)

    await run_web_server()
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
