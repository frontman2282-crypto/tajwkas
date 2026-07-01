"""
Бот на aiogram + создание инвойса звёздами (Telegram Stars, валюта XTR)
для товара "dystopia" за 1 звезду.

Что делает этот файл:
1. Поднимает обычного aiogram-бота (long polling), который умеет
   принимать pre_checkout_query и successful_payment.
2. Поднимает рядом aiohttp веб-сервер с маршрутами:
   - POST /create_invoice — дёргает script.js, чтобы получить ссылку
     на инвойс и открыть нативное окно оплаты через tg.openInvoice().
   - GET  /profile?user_id=... — отдаёт вкладке "Профиль" в мини-аппе
     количество покупок пользователя.

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
import logging

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
        "description": "Цифровой доступ к закрытой коллекции",
        "price": 1,
    }
}

# Доступные сроки доступа. Цена сейчас одинаковая для всех сроков (по просьбе),
# но при желании можно задать разную цену — просто поменяй значения price ниже
# и в create_invoice_handler бери цену из DURATIONS вместо PRODUCTS.
DURATIONS = {
    "1w": {"label": "1 неделя", "price": 1},
    "1m": {"label": "1 месяц", "price": 1},
    "1y": {"label": "1 год", "price": 1},
}

# Счётчик покупок на пользователя (для вкладки "Профиль" в мини-аппе).
# ВАЖНО: это простое хранилище в памяти процесса — оно обнуляется при
# каждом передеплое/рестарте на Render. Для честного постоянного счёта
# в будущем стоит подключить настоящую БД (например, Render Postgres
# или SQLite-файл на диске).
PURCHASES_BY_USER: dict[int, int] = {}

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
    # payload теперь в формате "product_id:duration_code", например "dystopia:1m"
    raw_payload = payment.invoice_payload
    product_id, _, duration_code = raw_payload.partition(":")
    duration_label = DURATIONS.get(duration_code, {}).get("label", "")
    user_id = message.from_user.id

    # Увеличиваем счётчик покупок пользователя (для вкладки "Профиль" в мини-аппе)
    PURCHASES_BY_USER[user_id] = PURCHASES_BY_USER.get(user_id, 0) + 1

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
    duration_code = data.get("duration", "1m")

    product = PRODUCTS.get(product_id)
    duration = DURATIONS.get(duration_code)

    if not product:
        return web.json_response({"error": "unknown product"}, status=404)
    if not duration:
        return web.json_response({"error": "unknown duration"}, status=404)

    title = product["title"]
    description = f"{product['description']} — доступ на {duration['label']}"
    payload = f"{product_id}:{duration_code}"  # вернётся в successful_payment.invoice_payload

    invoice_link = await bot.create_invoice_link(
        title=title,
        description=description,
        payload=payload,
        provider_token="",           # для звёзд (XTR) всегда пустая строка
        currency="XTR",
        prices=[LabeledPrice(label=title, amount=duration["price"])],
    )

    return web.json_response({"invoice_link": invoice_link})


async def profile_handler(request: web.Request) -> web.Response:
    user_id_raw = request.query.get("user_id")

    if not user_id_raw or not user_id_raw.isdigit():
        return web.json_response({"error": "invalid user_id"}, status=400)

    user_id = int(user_id_raw)
    purchases = PURCHASES_BY_USER.get(user_id, 0)

    return web.json_response({"purchases": purchases})


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


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/create_invoice", create_invoice_handler)
    app.router.add_get("/profile", profile_handler)
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
