"""
Бот на aiogram + создание инвойса звёздами (Telegram Stars, валюта XTR)
для товара "dystopia" за 1 звезду.

Что делает этот файл:
1. Поднимает обычного aiogram-бота (long polling), который умеет
   принимать pre_checkout_query и successful_payment.
2. Поднимает рядом aiohttp веб-сервер с маршрутами:
   - POST /create_invoice — дёргает script.js, чтобы получить ссылку
     на инвойс и открыть нативное окно оплаты через tg.openInvoice().
   - POST /open_case — выдаёт бесплатный одноразовый промокод
     (Kichiro-XXXXX) со случайной скидкой (5/10/15/30/50%, вес
     выпадения 110:70:25:3:1).
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
     управление многоразовыми промокодами из админ-панели (только для
     ADMIN_ID).

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
import json
import logging
import math
import random
import string

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

# ====== Админ ======
# Единственный пользователь, которому доступна вкладка "Админ-панель" в
# мини-аппе. Проверка всегда идёт по user_id, извлечённому из подписанного
# initData (см. resolve_user), а не по тому, что прислал клиент, — так
# никто другой не сможет открыть панель, даже подделав запрос.
ADMIN_ID = 8606714114
ADMIN_USERNAME = "meaninglessperson"  # только для справки/отображения

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
DURATIONS = {
    "7d": {"label": "7 дней", "price": 2},
    "30d": {"label": "30 дней", "price": 2},
    "12m": {"label": "12 месяцев", "price": 2},
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
# выпадения, а не проценты от 100. При сумме весов 259 фактические шансы:
# 5% = 57.9%, 10% = 38.6%, 15% = 1.9%, 30% = 1.2%, 50% = 0.4%.
# Шансы на 15% и 50% дополнительно понижены (было 7.0% и 0.5%
# соответственно) — вес 15% уменьшен почти в 3 раза, а веса частых призов
# (5% и 10%) увеличены, чтобы общая сумма выросла и редкие призы стали
# выпадать ещё реже. Выбор по-прежнему полностью случайный
# (random.choices) — поменяй числа, если нужны другие шансы.
CASE_PRIZES = [
    (5, 150),
    (10, 100),
    (15, 5),
    (30, 3),
    (50, 1),
]

# Пока кейс бесплатный — открыть его можно сколько угодно раз без оплаты.
# Когда понадобится сделать его платным, тут же можно списывать звёзды
# перед вызовом roll_case_prize() в open_case_handler.
CASE_IS_FREE = True

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


def _parse_ban_target(raw: str) -> tuple[int | None, str | None]:
    """Разбирает то, что ввёл админ в поле "юзернейм или id" — либо
    числовой id, либо username (с "@" или без)."""
    target = raw.strip().lstrip("@")
    if target.isdigit():
        return int(target), None
    return None, target.lower() if target else None


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
        return parsed.user.id if parsed.user else None
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
        return parsed.user.id, username
    except Exception:
        return None, None


def is_admin_init_data(init_data_raw: str | None) -> bool:
    """Проверяет, что запрос реально пришёл от ADMIN_ID (по подписанному
    initData, а не по тому, что написал клиент)."""
    user_id, _ = resolve_user(init_data_raw)
    return user_id == ADMIN_ID


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

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


# ====== Хендлеры бота ======

@dp.message(CommandStart())
async def start_handler(message: Message):
    username = message.from_user.username.lower() if message.from_user.username else None
    if is_banned(message.from_user.id, username):
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
    duration_label = DURATIONS.get(duration_code, {}).get("label", "")

    # promo_field теперь в формате "тип:ключ" (например "case:KICHIRO-A1B2C"
    # или "admin:SALE50"), либо пустой, если промокод не применялся или был
    # статическим. Списываем использование только теперь, когда оплата
    # реально прошла (а не просто была создана ссылка на инвойс).
    if promo_field and ":" in promo_field:
        promo_type, promo_key = promo_field.split(":", 1)
        if promo_type == "case" and promo_key in GENERATED_PROMOS:
            GENERATED_PROMOS[promo_key]["used"] = True
            _save_generated_promos()
        elif promo_type == "admin" and promo_key in ADMIN_PROMOS:
            ADMIN_PROMOS[promo_key]["activations"] += 1
            _save_admin_promos()

    # ЗДЕСЬ выдаёшь товар пользователю: открываешь доступ, шлёшь файл/ссылку и т.д.
    duration_text = f" на срок «{duration_label}»" if duration_label else ""
    await message.answer(
        f"Оплата получена: {payment.total_amount} ★\n"
        f"Товар «{product_id}»{duration_text} выдан. Спасибо за покупку!"
    )


# ====== HTTP-эндпоинт для мини-аппа ======

async def create_invoice_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    product_id = data.get("product_id")
    duration_code = data.get("duration", "30d")
    promo_code_raw = data.get("promo_code")

    # Дополнительная защита: даже если забаненный пользователь как-то
    # обошёл проверку /check_ban на фронтенде, инвойс всё равно не
    # создастся.
    ban_user_id, ban_username = resolve_user(data.get("init_data"))
    if is_banned(ban_user_id, ban_username):
        return web.json_response({"error": "banned"}, status=403)

    product = PRODUCTS.get(product_id)
    duration = DURATIONS.get(duration_code)

    if not product:
        return web.json_response({"error": "unknown product"}, status=404)
    if not duration:
        return web.json_response({"error": "unknown duration"}, status=404)

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


async def open_case_handler(request: web.Request) -> web.Response:
    """Открывает бесплатный кейс и выдаёт одноразовый промокод.

    Шансы выпадения скидок заданы весами в CASE_PRIZES (5%/10%/15%/30%/50%
    в пропорции 105:75:14:5:1, т.е. 52.5%/37.5%/7%/2.5%/0.5%). Код
    одноразовый и живёт, пока не будет использован при успешной оплате
    (см. successful_payment_handler).
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    # Привязываем сгенерированный код к конкретному пользователю Telegram
    # (если initData передан и валиден) — это и позволяет потом показать
    # человеку список именно ЕГО неиспользованных кодов в "Моих промокодах".
    user_id = resolve_user_id(body.get("init_data"))

    # Пока CASE_IS_FREE — открытие кейса ничего не стоит. Когда кейс
    # станет платным, здесь нужно будет списать звёзды/проверить оплату
    # перед тем, как выдавать промокод.
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
    return web.json_response({"banned": is_banned(user_id, username)})


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

    # Не даём админу случайно забанить самого себя.
    if target_id == ADMIN_ID or (target_username and target_username == ADMIN_USERNAME.lower()):
        return web.json_response({"error": "cannot ban admin"}, status=400)

    existing_key = _find_ban_entry(target_id, target_username)
    key = existing_key or f"ban_{len(BANNED_USERS) + 1}_{random.randint(1000, 9999)}"
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
    app.router.add_post("/open_case", open_case_handler)
    app.router.add_post("/my_promo_codes", my_promo_codes_handler)
    app.router.add_post("/delete_promo_codes", delete_promo_codes_handler)
    app.router.add_post("/delete_all_promo_codes", delete_all_promo_codes_handler)
    app.router.add_get("/validate_promo", validate_promo_handler)
    app.router.add_post("/check_ban", check_ban_handler)
    app.router.add_post("/admin/ban", admin_ban_handler)
    app.router.add_post("/admin/unban", admin_unban_handler)
    app.router.add_post("/admin/banned_list", admin_banned_list_handler)
    app.router.add_post("/admin/promo/create", admin_promo_create_handler)
    app.router.add_post("/admin/promo/delete", admin_promo_delete_handler)
    app.router.add_post("/admin/promo/list", admin_promo_list_handler)
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
