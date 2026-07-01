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

import os

# ====== Настройки ======
# Токен бери из переменных окружения хостинга (Render: Environment -> Add variable),
# либо, для быстрого локального теста, можно временно вписать строкой прямо тут.
BOT_TOKEN = os.environ.get("BOT_TOKEN", "ВСТАВЬ_СЮДА_ТОКЕН_БОТА")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://твой-адрес.onrender.com")
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8080))  # Render подставит свой PORT сам

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
# выпадения, а не проценты от 100. При сумме весов 209 фактические шансы:
# 5% ≈ 52.6%, 10% ≈ 33.5%, 15% ≈ 12.0%, 30% ≈ 1.4%, 50% ≈ 0.5%.
# Выбор по-прежнему полностью случайный (random.choices) — при таких весах
# 5% и 10% просто статистически выпадают в разы чаще остальных, поэтому
# может казаться, что "всегда одно и то же". Поменяй числа, если нужны
# другие шансы.
CASE_PRIZES = [
    (5, 110),
    (10, 70),
    (15, 25),
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
    dynamic = GENERATED_PROMOS.get(key)
    if dynamic and not dynamic["used"]:
        return dynamic["discount_percent"], {"type": "case", "key": key}

    return 0, None


def apply_promo(base_price: int, promo_code: str | None) -> tuple[int, dict | None]:
    """Считает итоговую цену в звёздах с учётом промокода (статического
    или сгенерированного кейсом).

    Возвращает (итоговая_цена, метаданные_промокода_или_None).
    Цена в Stars — это целое число, поэтому скидка округляется,
    а итоговая цена никогда не опускается ниже 1 звезды.
    """
    discount_percent, promo_meta = resolve_promo(promo_code)
    if promo_meta is None:
        return base_price, None

    final_price = max(1, round(base_price * (1 - discount_percent / 100)))
    promo_meta = {**promo_meta, "discount_percent": discount_percent}
    return final_price, promo_meta

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


# ====== Хендлеры бота ======

@dp.message(CommandStart())
async def start_handler(message: Message):
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
    promo_key = parts[2] if len(parts) > 2 else ""
    duration_label = DURATIONS.get(duration_code, {}).get("label", "")

    # Кейсовый промокод одноразовый — помечаем его использованным только
    # теперь, когда оплата реально прошла (а не просто была создана ссылка).
    if promo_key and promo_key in GENERATED_PROMOS:
        GENERATED_PROMOS[promo_key]["used"] = True
        _save_generated_promos()

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

    # Для одноразовых кейсовых промокодов кладём их ключ в payload —
    # так бот сможет пометить код использованным именно в момент успешной
    # оплаты (successful_payment_handler), а не раньше, чтобы отменённая
    # или неудавшаяся оплата не "сжигала" код впустую.
    promo_key_for_payload = promo["key"] if promo_applied and promo.get("type") == "case" else ""
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
    в пропорции 110:70:25:3:1). Код одноразовый и живёт, пока не будет
    использован при успешной оплате (см. successful_payment_handler).
    """
    # Пока CASE_IS_FREE — открытие кейса ничего не стоит. Когда кейс
    # станет платным, здесь нужно будет списать звёзды/проверить оплату
    # перед тем, как выдавать промокод.
    discount_percent = roll_case_prize()
    code = generate_case_code()
    GENERATED_PROMOS[code.upper()] = {
        "code": code,
        "discount_percent": discount_percent,
        "used": False,
    }
    _save_generated_promos()

    return web.json_response({
        "code": code,
        "discount_percent": discount_percent,
        "is_free": CASE_IS_FREE,
    })


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
    app.router.add_get("/validate_promo", validate_promo_handler)
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
