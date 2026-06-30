"""
Бот на aiogram + создание инвойса звёздами (Telegram Stars, валюта XTR)
для товара "dystopia" за 150 звёзд.

Что делает этот файл:
1. Поднимает обычного aiogram-бота (long polling), который умеет
   принимать pre_checkout_query и successful_payment.
2. Поднимает рядом aiohttp веб-сервер с маршрутом POST /create_invoice —
   именно его дёргает script.js из мини-аппа, чтобы получить ссылку
   на инвойс и открыть нативное окно оплаты через tg.openInvoice().

Установка зависимостей (aiogram у тебя уже есть):
    pip install aiohttp aiohttp-cors

Запуск:
    python bot.py

Важно:
- Для оплаты звёздами provider_token в send_invoice / create_invoice_link
  должен быть пустой строкой "", а currency = "XTR".
- prices указываются в LabeledPrice, amount — это просто 150 (без умножения
  на 100, как в обычных валютах — у звёзд множитель 1).
- Мини-апп (index.html/style.css/script.js) должен быть захостен на
  HTTPS-домене (например, GitHub Pages, Vercel, или твой же сервер) и
  подключён в @BotFather через /newapp или как Menu Button.
"""

import asyncio
import logging

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
        "price": 150,
    }
}

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
    # payment.invoice_payload содержит product_id, который мы передали при создании инвойса
    product_id = payment.invoice_payload

    # ЗДЕСЬ выдаёшь товар пользователю: открываешь доступ, шлёшь файл/ссылку и т.д.
    await message.answer(
        f"Оплата получена: {payment.total_amount} ★\n"
        f"Товар «{product_id}» выдан. Спасибо за покупку!"
    )


# ====== HTTP-эндпоинт для мини-аппа ======

async def create_invoice_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    product_id = data.get("product_id")
    product = PRODUCTS.get(product_id)

    if not product:
        return web.json_response({"error": "unknown product"}, status=404)

    invoice_link = await bot.create_invoice_link(
        title=product["title"],
        description=product["description"],
        payload=product_id,          # вернётся в successful_payment.invoice_payload
        provider_token="",           # для звёзд (XTR) всегда пустая строка
        currency="XTR",
        prices=[LabeledPrice(label=product["title"], amount=product["price"])],
    )

    return web.json_response({"invoice_link": invoice_link})


async def index_handler(request: web.Request) -> web.Response:
    return web.FileResponse("static/index.html")


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/create_invoice", create_invoice_handler)
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
