// ====== Каталог товаров ======
// Чтобы добавить новый товар — просто добавь объект в этот массив.
// id должен совпадать с ключом PRODUCTS в bot.py.
const PRODUCTS = [
  {
    id: "dystopia",
    title: "Dystopia",
    subtitle: "",
    description: "",
    price: 2,
    initial: "D",
    // Квадратный логотип товара — используется в шапке экрана оформления
    // вместо буквы-заглушки.
    logo: "assets/dystlogo.png",
    // Бейджи на карточке магазина (см. renderProducts) — короткие статусные
    // пилюли поверх обложки assets/dystopia.png.
    badges: ["UNDETECTED"],
  },
];

// Сроки доступа — должны совпадать с DURATIONS в bot.py.
// Цены указаны в звёздах (Telegram Stars) — поменяй значения price
// на свои под каждый тариф.
const DURATIONS = [
  { code: "7d", label: "7 дней", price: 370 },
  { code: "30d", label: "30 дней", price: 500 },
  { code: "12m", label: "12 месяцев", price: 3000 },
];

// Цены в рублях при оплате способом "RU карта" — оформляется вручную
// через личные сообщения с владельцем, поэтому цены задаются отдельно
// от цен в Telegram Stars.
const RU_CARD_PRICES = { "7d": 550, "30d": 750, "12m": 4500 };

// Цены в гривнах при оплате способом "UAH (Гривна)" — оформляется точно
// так же вручную, перепиской с владельцем в личных сообщениях.
const UAH_CARD_PRICES = { "7d": 320, "30d": 445, "12m": 2600 };

// Цены в USDT при оплате способом "xRocket" (крипта, оплата автоматическая
// — как и Stars, без переписки с владельцем). Должны совпадать с
// XROCKET_PRICES в bot.py. Реальная валюта инвойса на стороне xRocket
// остаётся USDT (см. XROCKET_CURRENCY в bot.py) — здесь меняется только
// то, что видит пользователь в интерфейсе (символ доллара вместо "USDT").
const XROCKET_PRICES = { "7d": 7, "30d": 10, "12m": 50 };
const XROCKET_CURRENCY = "$";

// Промокод проверяется и считается всегда на сервере (в bot.py) — это
// касается и статических кодов, и одноразовых кодов из кейса, клиенту в
// этом вопросе не доверяем.

// Иконка звезды (Telegram Stars) — используется вместо символа "★",
// который выглядит по-разному в разных шрифтах/системах
const STAR_ICON_SVG = `<svg class="icon-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 14.47 8.6 21.51 8.91 16 13.3 17.88 20.09 12 16.2 6.12 20.09 8.01 13.3 2.49 8.91 9.53 8.6Z"/></svg>`;

// ====== Инициализация Telegram WebApp ======
const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#050208");
  tg.setBackgroundColor("#050208");
  // Запрещаем системный жест "потянуть вниз, чтобы закрыть" — без этого
  // на iOS можно было утащить весь Mini App вниз и увидеть пустоту под
  // интерфейсом. Метод есть только в Bot API 7.7+, поэтому оборачиваем
  // в try/catch на случай старых клиентов Telegram.
  try {
    tg.disableVerticalSwipes?.();
  } catch (err) {
    // старая версия клиента — просто игнорируем
  }
}

// ====== Реальная высота вьюпорта (фикс для клавиатуры) ======
// 100dvh на iOS не всегда пересчитывается, когда открывается клавиатура —
// из-за этого нижняя часть интерфейса (промокод, кнопка "Купить", таббар)
// уезжала под клавиатуру и всё "ломалось" визуально. window.visualViewport
// даёт настоящую видимую высоту, на неё и завязываемся.
// Заодно, пока клавиатура открыта, прячем нижний таббар — на экране
// оформления он всё равно не нужен, а место для полей освобождает.
function setAppHeight() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", vh + "px");

  const keyboardLikelyOpen = window.innerHeight - vh > 120;
  document.body.classList.toggle("keyboard-open", keyboardLikelyOpen);
}

setAppHeight();

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", setAppHeight);
} else {
  window.addEventListener("resize", setAppHeight);
}

// Также ещё раз "поджимаем" жест закрытия шторки при каждом ресайзе —
// на некоторых клиентах открытие клавиатуры сбрасывает это состояние.
if (tg) {
  window.addEventListener("resize", () => {
    try {
      tg.disableVerticalSwipes?.();
    } catch (err) {
      // игнорируем
    }
  });
}

// ====== Владелец ======
// id владельца — держим тут только для справки/комментариев. Видимость
// вкладки "Админ" и всех прав больше НЕ проверяется по этой константе на
// клиенте: теперь она полностью решается сервером через /admin/whoami (по
// подписанному initData), т.к. владелец может назначать других админов с
// произвольными id — см. checkAdminAccess() ниже.
const ADMIN_ID = 8606714114;

// Запускаем проверку бана СРАЗУ, не дожидаясь окончания сплэша — так к
// моменту, когда сплэш обычно скрывается, ответ сервера уже готов и не
// добавляет дополнительной задержки.
//
// У fetch() нет встроенного таймаута: если сервер недоступен, спит или
// просто не отвечает, запрос может зависнуть на неопределённое время, а
// экран загрузки (см. hideSplash ниже) ждёт именно этот промис — из-за
// этого сплэш мог не скрываться вообще. AbortController здесь обрывает
// запрос через CHECK_BAN_TIMEOUT_MS и считает пользователя не забаненным,
// если сервер не успел ответить.
const CHECK_BAN_TIMEOUT_MS = 4000;

function checkBanStatus() {
  if (!tg) return Promise.resolve(false);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_BAN_TIMEOUT_MS);

  return fetch("/check_ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: tg.initData }),
    signal: controller.signal,
  })
    .then((r) => r.json())
    .then((data) => !!data.banned)
    .catch(() => false)
    .finally(() => clearTimeout(timeoutId));
}

const banStatusPromise = checkBanStatus();

// ====== Сплэш / плавное появление ======
const splash = document.getElementById("splash");
const app = document.getElementById("app");
const bannedScreen = document.getElementById("bannedScreen");

let splashDone = false;

async function hideSplash() {
  if (splashDone) return;
  splashDone = true;

  // Доп. страховка сверху таймаута внутри checkBanStatus: даже если он по
  // какой-то причине не сработает, через HIDE_SPLASH_FALLBACK_MS сплэш всё
  // равно скроется (считая пользователя не забаненным), а не будет висеть
  // бесконечно.
  const HIDE_SPLASH_FALLBACK_MS = 5000;
  const fallback = new Promise((resolve) => setTimeout(() => resolve(false), HIDE_SPLASH_FALLBACK_MS));
  const banned = await Promise.race([banStatusPromise, fallback]).catch(() => false);

  splash.classList.add("splash--hidden");

  if (banned) {
    // Пользователь забанен — вместо приложения показываем экран-заглушку
    // и дальше приложение не инициализируем вовсе.
    bannedScreen.hidden = false;
    return;
  }

  app.classList.add("app--ready");
  initApp();

  // Сплэш полностью убираем из DOM после того, как доиграет его opacity-
  // transition (0.5s). До этого момента CSS уже ставит его анимации на
  // паузу (.splash--hidden — см. style.css), но сам узел с обвязкой
  // (5 keyframe-анимаций, blur-фильтры) до сих пор существовал в дереве
  // документа всю сессию просто "на всякий случай". Явное удаление — либо
  // по событию transitionend, либо (страховка) по таймеру — освобождает
  // память и убирает лишние слои у браузера.
  let splashRemoved = false;
  function removeSplash() {
    if (splashRemoved) return;
    splashRemoved = true;
    splash.remove();
  }
  splash.addEventListener("transitionend", removeSplash, { once: true });
  setTimeout(removeSplash, 700);
}

// Сплэш показывается РОВНО 4 секунды — фиксированная длительность, а не
// "пока реально грузится". Заодно эти 4 секунды не тратятся впустую: пока
// крутится спиннер, в фоне прогреваются шрифты и скрытые вкладки (см.
// warmUpHiddenViews/preloadFonts ниже) — это устраняет баг с задержкой
// появления интерфейса при первом открытии "Моих промокодов" или
// "Оформления заказа".
const SPLASH_DURATION = 2500;
setTimeout(hideSplash, SPLASH_DURATION);

// ====== Рендер карточек товаров ======
const productList = document.getElementById("productList");
const cardTemplate = document.getElementById("productCardTemplate");
const durationTemplate = document.getElementById("durationOptionTemplate");

// Стартовая цена для пилюли на обложке карточки ("от 550 ₽") — берём
// минимальную цену среди тарифов RU-карты (самый короткий срок, 7 дней),
// т.к. это единственный способ оплаты с ценой именно в рублях.
function getStartingRubPrice() {
  const values = Object.values(RU_CARD_PRICES);
  const min = Math.min(...values);
  return min.toLocaleString("ru-RU");
}

// Иконки для пилюли с ценой на карточке — те же самые SVG, что и в
// способах оплаты на экране оформления (см. #paymentOptions в index.html),
// чтобы звёзды/доллары/гривны/рубли выглядели одинаково везде.
const HERO_PRICE_STAR_ICON =
  '<svg class="card-hero-price-icon card-hero-price-icon--star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 14.47 8.6 21.51 8.91 16 13.3 17.88 20.09 12 16.2 6.12 20.09 8.01 13.3 2.49 8.91 9.53 8.6Z"/></svg>';

function heroPriceBadgeIcon(symbol) {
  return (
    '<svg class="card-hero-price-icon card-hero-price-icon--badge" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.15"/>' +
    '<text x="12" y="17.5" text-anchor="middle" font-family="\'Golos Text\', Arial, sans-serif" font-size="15" font-weight="800" fill="currentColor">' +
    symbol +
    "</text></svg>"
  );
}

// Пилюля с ценой на карточке магазина по очереди показывает стартовую
// цену в каждом из способов оплаты (7-дневный тариф — самый дешёвый),
// с плавной анимацией перехода между значениями (см. .card-hero-price-value
// и класс .is-fading в style.css). Вместо слов "звёзд"/"грн" используем
// те же SVG-иконки, что и в списке способов оплаты в тарифах.
function buildHeroPriceCycle() {
  return [
    `${getStartingRubPrice()} ${heroPriceBadgeIcon("₽")}`,
    `${DURATIONS[0].price.toLocaleString("ru-RU")} ${HERO_PRICE_STAR_ICON}`,
    `${XROCKET_PRICES["7d"]} ${heroPriceBadgeIcon("$")}`,
    `${UAH_CARD_PRICES["7d"].toLocaleString("ru-RU")} ${heroPriceBadgeIcon("₴")}`,
  ];
}

// ID интервалов анимации цены на карточках — чистятся при каждом
// перерисовывании списка, чтобы при повторном renderProducts() не
// накапливались "осиротевшие" таймеры на удалённых из DOM карточках.
let heroPriceIntervals = [];

function renderProducts() {
  productList.innerHTML = "";
  heroPriceIntervals.forEach((id) => clearInterval(id));
  heroPriceIntervals = [];

  PRODUCTS.forEach((product, index) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector(".card");
    card.dataset.productId = product.id;
    card.style.setProperty("--card-index", index);

    const btn = node.querySelector(".card-hero-btn");
    const badgesEl = node.querySelector(".card-hero-badges");

    (product.badges || []).forEach((badgeText) => {
      const b = document.createElement("span");
      // UNDETECTED — статус безопасности, выделяем его зелёным, как
      // положительный индикатор. Остальные возможные бейджи остаются
      // в нейтральном тёмном стиле.
      b.className =
        badgeText === "UNDETECTED"
          ? "card-hero-badge card-hero-badge--accent"
          : "card-hero-badge";
      b.textContent = badgeText;
      badgesEl.appendChild(b);
    });

    node.querySelector(".card-hero-title").textContent = product.title;
    node.querySelector(".card-hero-subtitle").textContent = product.subtitle;

    const priceValueEl = node.querySelector(".card-hero-price-value");
    if (priceValueEl) {
      const cycle = buildHeroPriceCycle();
      let cycleIndex = 0;
      priceValueEl.innerHTML = cycle[cycleIndex];

      const intervalId = setInterval(() => {
        priceValueEl.classList.add("is-fading");
        setTimeout(() => {
          cycleIndex = (cycleIndex + 1) % cycle.length;
          priceValueEl.innerHTML = cycle[cycleIndex];
          priceValueEl.classList.remove("is-fading");
        }, 260);
      }, 2200);
      heroPriceIntervals.push(intervalId);
    }

    // Клик по карточке — переходим на отдельный экран оформления покупки
    btn.addEventListener("click", () => {
      openCheckout(product);
      tg?.HapticFeedback?.selectionChanged();
    });

    productList.appendChild(node);
  });
}

function getFinalPrice(basePrice, discountPercent) {
  if (!discountPercent) return basePrice;
  // floor, а не round — так же, как считает сервер (apply_promo в bot.py),
  // чтобы цена на экране всегда совпадала с той, что реально спишется.
  return Math.max(1, Math.floor(basePrice * (1 - discountPercent / 100)));
}

// Считает итоговую цену с округлением до центов (2 знака) — так же, как
// apply_promo_float на сервере (bot.py) для xRocket, чтобы цена на экране
// совпадала с той, что реально спишется в USDT.
function getFinalPriceFloat(basePrice, discountPercent) {
  if (!discountPercent) return Math.round(basePrice * 100) / 100;
  return Math.max(0.01, Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100);
}

// Форматирует сумму для отображения: для xRocket знак доллара ставится
// перед числом без пробела ("$7"), для остальных способов (Stars/₽/₴)
// используется прежний порядок "число + значок/символ".
function formatAmount(amount, isXRocket) {
  if (isXRocket) return `${XROCKET_CURRENCY}${amount}`;
  return `${amount} ${STAR_ICON_SVG}`;
}

function updateBuyButtonLabel(buyBtnText, product, durationCode) {
  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];

  // Кнопка "Купить" (checkoutBuyBtn) используется и для Stars, и для
  // xRocket — оба способа автоматические (в отличие от NFT/card/uah,
  // которые оформляются перепиской через checkoutManualBtn).
  const isXRocket = checkoutPaymentMethod === "xrocket";
  const basePrice = isXRocket ? XROCKET_PRICES[duration.code] : duration.price;
  const finalPrice = isXRocket
    ? getFinalPriceFloat(basePrice, checkoutDiscountPercent)
    : getFinalPrice(basePrice, checkoutDiscountPercent);
  const hasDiscount = checkoutDiscountPercent > 0 && finalPrice < basePrice;

  // Зачёркнутая исходная цена показывается прямо на кнопке "Купить" рядом
  // с новой ценой со скидкой — работает для любого процента скидки
  // (в т.ч. 5%), т.к. итоговая цена всегда считается на сервере (floor).
  if (hasDiscount) {
    checkoutOldPrice.innerHTML = formatAmount(basePrice, isXRocket);
    checkoutOldPrice.hidden = false;
  } else {
    checkoutOldPrice.hidden = true;
  }

  buyBtnText.innerHTML = hasDiscount
    ? `Купить за ${formatAmount(finalPrice, isXRocket)}`
    : `Купить за ${formatAmount(basePrice, isXRocket)}`;
}

// Отрисовывает цену тарифа в блоке "Тариф" в зависимости от выбранного
// способа оплаты: звёзды и RU карта показывают цену с учётом промокода
// (зачёркнутая исходная цена + цена со скидкой, если промокод применён),
// NFT — предложение узнать цену у владельца (оформляется вручную, у него
// нет фиксированной цены, поэтому скидку тут не считаем).
function applyDurationPrice(priceEl, duration) {
  if (!priceEl) return;

  if (checkoutPaymentMethod === "nft") {
    priceEl.classList.add("duration-option-price--note");
    priceEl.classList.remove("duration-option-price--discounted");
    priceEl.textContent = "Узнайте цену у владельца";
    return;
  }

  priceEl.classList.remove("duration-option-price--note");

  const isCard = checkoutPaymentMethod === "card";
  const isUah = checkoutPaymentMethod === "uah";
  const isXRocket = checkoutPaymentMethod === "xrocket";
  const basePrice = isCard
    ? RU_CARD_PRICES[duration.code]
    : isUah
      ? UAH_CARD_PRICES[duration.code]
      : isXRocket
        ? XROCKET_PRICES[duration.code]
        : duration.price;

  if (basePrice == null) {
    priceEl.classList.remove("duration-option-price--discounted");
    priceEl.innerHTML = "—";
    return;
  }

  const finalPrice = isXRocket
    ? getFinalPriceFloat(basePrice, checkoutDiscountPercent)
    : getFinalPrice(basePrice, checkoutDiscountPercent);
  const hasDiscount = checkoutDiscountPercent > 0 && finalPrice < basePrice;

  const format = (value) => {
    if (isCard) return `${value} ₽`;
    if (isUah) return `${value} ₴`;
    if (isXRocket) return formatAmount(value, true);
    return `${value} ${STAR_ICON_SVG}`;
  };

  if (hasDiscount) {
    priceEl.classList.add("duration-option-price--discounted");
    priceEl.innerHTML =
      `<span class="duration-option-price-old">${format(basePrice)}</span>` +
      `<span class="duration-option-price-new">${format(finalPrice)}</span>`;
  } else {
    priceEl.classList.remove("duration-option-price--discounted");
    priceEl.innerHTML = format(basePrice);
  }
}

// Перерисовывает цены во всех уже отрендеренных карточках тарифа —
// вызывается при смене способа оплаты, чтобы цены сразу обновились без
// необходимости заново открывать экран оформления.
function refreshDurationPrices() {
  checkoutDurations.querySelectorAll(".duration-option").forEach((btn) => {
    const duration = DURATIONS.find((d) => d.code === btn.dataset.duration);
    if (!duration) return;
    applyDurationPrice(btn.querySelector(".duration-option-price"), duration);
  });
}

function setCardStatus(statusEl, text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "card-status" + (type ? " " + type : "");
}

function setPromoStatus(text, type = "") {
  checkoutPromoStatus.textContent = text;
  checkoutPromoStatus.className = "promo-status" + (type ? " " + type : "");
}

async function getInvoiceLink(productId, durationCode, promoCode) {
  const initData = tg ? tg.initData : "";

  const response = await fetch("/create_invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      duration: durationCode,
      promo_code: promoCode || undefined,
      init_data: initData,
    }),
  });

  if (!response.ok) {
    throw new Error("Сервер не смог создать инвойс");
  }

  const data = await response.json();
  if (!data.invoice_link) {
    throw new Error("Сервер не вернул ссылку на инвойс");
  }

  return data;
}

// ====== xRocket Pay (крипта) ======
// В отличие от Stars, у xRocket нет встроенного в Telegram колбэка вроде
// tg.openInvoice — ссылка на оплату открывается как обычная веб-страница
// (или чат с ботом @xRocket), а результат оплаты бот получает отдельно,
// через вебхук на сервере (см. /xrocket_webhook в bot.py). Поэтому здесь
// после открытия ссылки просто опрашиваем сервер, пока статус счёта не
// станет "paid" (или пока не истечёт время ожидания).

async function getXRocketInvoice(productId, durationCode, promoCode) {
  const initData = tg ? tg.initData : "";

  const response = await fetch("/create_invoice_xrocket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      duration: durationCode,
      promo_code: promoCode || undefined,
      init_data: initData,
    }),
  });

  if (!response.ok) {
    throw new Error("Сервер не смог создать счёт xRocket");
  }

  const data = await response.json();
  if (!data.invoice_link || !data.invoice_id) {
    throw new Error("Сервер не вернул ссылку на оплату xRocket");
  }

  return data;
}

// Опрашивает статус счёта xRocket раз в 2.5с. Останавливается, когда счёт
// оплачен, когда истёк таймаут (по умолчанию 10 минут — счёт живёт 30 мин
// на сервере, но незачем держать пользователя на экране дольше) или когда
// вызвали cancel() (например, ушли с экрана оформления).
function pollXRocketInvoice(invoiceId, { intervalMs = 2500, timeoutMs = 10 * 60 * 1000 } = {}) {
  let cancelled = false;
  const startedAt = Date.now();

  const promise = new Promise((resolve) => {
    const tick = async () => {
      if (cancelled) return resolve("cancelled");
      if (Date.now() - startedAt > timeoutMs) return resolve("timeout");

      try {
        const res = await fetch(`/xrocket_invoice_status?invoice_id=${encodeURIComponent(invoiceId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === "paid") return resolve("paid");
        }
      } catch (err) {
        // сетевая ошибка — просто попробуем ещё раз на следующем тике
      }

      setTimeout(tick, intervalMs);
    };

    tick();
  });

  return { promise, cancel: () => { cancelled = true; } };
}

async function handleBuyXRocket(product, durationCode, buyBtn, buyBtnText, statusEl) {
  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];

  buyBtn.disabled = true;
  buyBtnText.textContent = "Открываем оплату...";
  setCardStatus(statusEl, "");

  try {
    const invoiceData = await getXRocketInvoice(product.id, durationCode, checkoutPromoCode);

    if (checkoutPromoCode && invoiceData.promo_invalid) {
      checkoutPromoCode = null;
      checkoutDiscountPercent = 0;
      checkoutPromoApply.textContent = "Применить";
      checkoutPromoApply.classList.remove("promo-apply-btn--applied");
      checkoutPromoInput.disabled = false;
      checkoutPromoInput.value = "";
      setPromoStatus("Промокод не найден или уже использован, покупка по полной цене", "error");
    }

    // Ссылка на оплату xRocket — это обычно t.me-ссылка (переход в бота
    // @xRocket или в его мини-апп для оплаты). tg.openLink() для таких
    // ссылок открывает внешний/встроенный БРАУЗЕР — именно это и уводило
    // из Telegram. tg.openTelegramLink() вместо этого просит сам клиент
    // Telegram обработать t.me-ссылку своими средствами: переключиться на
    // чат/мини-апп внутри приложения, без браузера.
    //
    // Если xRocket в ответе присылает отдельную ссылку на именно
    // мини-апп оплаты (например, поле miniApp/webApp — нужно проверить
    // реальный ответ своего API-ключа, см. комментарий у xrocket_request
    // в bot.py), лучше открывать её тем же способом — тогда пользователя
    // не перекинет даже на экран чата с ботом и не понадобится нажимать
    // "Старт": просто замени invoiceData.invoice_link на это поле здесь
    // и в create_invoice_xrocket_handler/create_case_invoice_xrocket_handler.
    const link = invoiceData.invoice_link;
    if (tg?.openTelegramLink && /^https?:\/\/(www\.)?t\.me\//i.test(link)) {
      tg.openTelegramLink(link);
    } else if (tg?.openLink) {
      tg.openLink(link, { try_instant_view: false });
    } else {
      window.open(link, "_blank");
    }

    setCardStatus(statusEl, "Ждём оплату в xRocket...");
    buyBtnText.textContent = "Ожидание оплаты...";

    const { promise } = pollXRocketInvoice(invoiceData.invoice_id);
    const result = await promise;

    buyBtn.disabled = false;
    refreshAllPrices();

    if (result === "paid") {
      setCardStatus(statusEl, `Оплата прошла! Доступ на ${duration.label} выдан.`, "success");
      tg?.HapticFeedback?.notificationOccurred("success");
    } else if (result === "timeout") {
      setCardStatus(statusEl, "Время ожидания оплаты истекло. Если оплатили — доступ придёт от бота отдельным сообщением.");
    } else {
      setCardStatus(statusEl, "Ожидание оплаты отменено");
    }
  } catch (err) {
    buyBtn.disabled = false;
    refreshAllPrices();
    setCardStatus(statusEl, err.message || "Ошибка при создании оплаты xRocket", "error");
  }
}

async function handleBuy(product, durationCode, buyBtn, buyBtnText, statusEl) {
  if (!tg) {
    setCardStatus(statusEl, "Открой это приложение внутри Telegram", "error");
    return;
  }

  if (checkoutPaymentMethod === "xrocket") {
    return handleBuyXRocket(product, durationCode, buyBtn, buyBtnText, statusEl);
  }

  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];

  buyBtn.disabled = true;
  buyBtnText.textContent = "Открываем оплату...";
  setCardStatus(statusEl, "");

  try {
    const invoiceData = await getInvoiceLink(product.id, durationCode, checkoutPromoCode);
    const invoiceLink = invoiceData.invoice_link;

    // Сервер — источник истины по промокодам. Если он не распознал код,
    // который клиент посчитал валидным (например, код успели использовать
    // в другом месте, он истёк, или состояние сервера сбросилось), нельзя
    // просто показать текст ошибки поверх — нужно ПОЛНОСТЬЮ сбросить
    // визуальное состояние "применено", иначе кнопка промокода остаётся
    // зелёной ("Применено"), а под ней текст говорит, что код не найден —
    // именно это выглядело как баг на скриншоте.
    if (checkoutPromoCode && invoiceData.promo_invalid) {
      checkoutPromoCode = null;
      checkoutDiscountPercent = 0;
      checkoutPromoApply.textContent = "Применить";
      checkoutPromoApply.classList.remove("promo-apply-btn--applied");
      checkoutPromoInput.disabled = false;
      checkoutPromoInput.value = "";
      setPromoStatus("Промокод не найден или уже использован, покупка по полной цене", "error");
    }

    tg.openInvoice(invoiceLink, (status) => {
      buyBtn.disabled = false;
      refreshAllPrices();

      if (status === "paid") {
        setCardStatus(statusEl, `Оплата прошла! Доступ на ${duration.label} выдан.`, "success");
        tg.HapticFeedback?.notificationOccurred("success");
      } else if (status === "cancelled") {
        setCardStatus(statusEl, "Оплата отменена");
      } else if (status === "failed") {
        setCardStatus(statusEl, "Оплата не прошла", "error");
      } else {
        setCardStatus(statusEl, "Статус: " + status);
      }
    });
  } catch (err) {
    buyBtn.disabled = false;
    refreshAllPrices();
    setCardStatus(statusEl, err.message || "Ошибка при создании оплаты", "error");
  }
}

// ====== Экран оформления покупки (checkout) ======
const viewCheckout = document.getElementById("view-checkout");
const checkoutTitle = document.getElementById("checkoutTitle");
const checkoutInitial = document.getElementById("checkoutInitial");
const checkoutSubtitle = document.getElementById("checkoutSubtitle");
const galleryMain = document.getElementById("galleryMain");
const galleryMainImg = document.getElementById("galleryMainImg");
const galleryThumbs = document.getElementById("galleryThumbs");
const checkoutBadges = document.getElementById("checkoutBadges");
const checkoutDurations = document.getElementById("checkoutDurations");
const checkoutBuyBtn = document.getElementById("checkoutBuyBtn");
const checkoutBuyText = document.getElementById("checkoutBuyText");
const checkoutOldPrice = document.getElementById("checkoutOldPrice");
const checkoutStatus = document.getElementById("checkoutStatus");
const checkoutBack = document.getElementById("checkoutBack");
const checkoutPromoInput = document.getElementById("checkoutPromoInput");
const checkoutPromoApply = document.getElementById("checkoutPromoApply");
const checkoutPromoStatus = document.getElementById("checkoutPromoStatus");

// ====== Способ оплаты (Telegram Stars / NFT / Русская карта) ======
const paymentSelect = document.getElementById("paymentSelect");
const paymentToggle = document.getElementById("paymentToggle");
const paymentToggleIcon = document.getElementById("paymentToggleIcon");
const paymentToggleLabel = document.getElementById("paymentToggleLabel");
const paymentOptions = document.getElementById("paymentOptions");
const checkoutManualBtn = document.getElementById("checkoutManualBtn");
const checkoutManualOldPrice = document.getElementById("checkoutManualOldPrice");
const checkoutManualText = document.getElementById("checkoutManualText");
const nftModal = document.getElementById("nftModal");
const nftModalBackdrop = document.getElementById("nftModalBackdrop");
const nftModalTitle = document.getElementById("nftModalTitle");
const nftModalText = document.getElementById("nftModalText");
const nftModalCancel = document.getElementById("nftModalCancel");
const nftModalWrite = document.getElementById("nftModalWrite");

// Telegram-логины, которым пишет пользователь при оплате способами,
// оформляемыми вручную (NFT, RU карта, UAH). Оплата гривнами ведёт к
// администратору (alyuplost), NFT и RU карта — к владельцу
// (meaninglessperson). Задаётся отдельно на каждый способ в
// MANUAL_PAYMENT_METHODS через поле ownerUsername.
const MANUAL_PAYMENT_OWNER_USERNAME = "meaninglessperson";

// Способы оплаты, которые оформляются не автоматически, а перепиской в
// личных сообщениях (с владельцем или администратором — см. ownerUsername
// у каждого способа). Чтобы добавить новый такой способ, достаточно
// добавить сюда запись и кнопку .payment-option с тем же data-method в
// разметке.
const MANUAL_PAYMENT_METHODS = {
  nft: {
    buyLabel: "Нажмите для оплаты NFT",
    modalTitle: "Оплата NFT",
    modalText: "Напишите владельцу, чтобы оформить оплату NFT",
    ownerUsername: "meaninglessperson",
  },
  card: {
    buyLabel: "Нажмите для оплаты RU картой",
    modalTitle: "Оплата RU картой",
    modalText: "Напишите владельцу, чтобы оформить оплату RU картой",
    ownerUsername: "meaninglessperson",
  },
  uah: {
    buyLabel: "Нажмите для оплаты UAH (Гривны)",
    modalTitle: "Оплата UAH (Гривны)",
    modalText: "Напишите администратору, чтобы оформить оплату гривной",
    ownerUsername: "alyuplost",
  },
};

let checkoutPaymentMethod = "stars";

function updatePaymentToggleSummary(method) {
  const optionBtn = paymentOptions.querySelector(`.payment-option[data-method="${method}"]`);
  if (!optionBtn) return;

  const icon = optionBtn.querySelector("svg");
  paymentToggleIcon.innerHTML = icon ? icon.outerHTML : "";
  paymentToggleLabel.textContent = optionBtn.querySelector(".payment-option-label")?.textContent || "";
}

function setPaymentOptionsOpen(open) {
  paymentOptions.classList.toggle("payment-options--open", open);
  paymentToggle.classList.toggle("payment-toggle--open", open);
  paymentToggle.setAttribute("aria-expanded", String(open));
}

function togglePaymentOptions() {
  setPaymentOptionsOpen(!paymentOptions.classList.contains("payment-options--open"));
}

paymentToggle.addEventListener("click", () => {
  togglePaymentOptions();
  tg?.HapticFeedback?.selectionChanged();
});

function setPaymentMethod(method) {
  checkoutPaymentMethod = method;

  paymentOptions.querySelectorAll(".payment-option").forEach((btn) => {
    const isSelected = btn.dataset.method === method;
    btn.classList.toggle("payment-option--selected", isSelected);
    // Выбранный способ не нужно показывать в самом списке — он и так
    // виден в свёрнутой шапке (paymentToggle), а в списке остаются
    // только варианты, на которые можно переключиться.
    btn.hidden = isSelected;
  });
  updatePaymentToggleSummary(method);

  const manualConfig = MANUAL_PAYMENT_METHODS[method];
  if (manualConfig) {
    checkoutBuyBtn.hidden = true;
    checkoutManualBtn.hidden = false;
  } else {
    checkoutManualBtn.hidden = true;
    checkoutBuyBtn.hidden = false;
  }

  refreshAllPrices();
}

// Обновляет текст кнопки ручной оплаты (NFT / RU карта). Для RU карты —
// как и на "Купить" со звёздами — показывает зачёркнутую исходную цену и
// цену со скидкой, если применён промокод. У NFT фиксированной цены нет
// (оформляется перепиской с владельцем), поэтому для неё просто оставляем
// исходный текст без цены.
function updateManualButtonLabel() {
  const manualConfig = MANUAL_PAYMENT_METHODS[checkoutPaymentMethod];
  if (!manualConfig) return;

  if (checkoutPaymentMethod === "card" || checkoutPaymentMethod === "uah") {
    const duration = DURATIONS.find((d) => d.code === checkoutDuration) || DURATIONS[0];
    const priceMap = checkoutPaymentMethod === "card" ? RU_CARD_PRICES : UAH_CARD_PRICES;
    const unit = checkoutPaymentMethod === "card" ? "₽" : "₴";
    const basePrice = priceMap[duration.code];

    if (basePrice != null) {
      const finalPrice = getFinalPrice(basePrice, checkoutDiscountPercent);
      const hasDiscount = checkoutDiscountPercent > 0 && finalPrice < basePrice;

      if (hasDiscount) {
        checkoutManualOldPrice.textContent = `${basePrice} ${unit}`;
        checkoutManualOldPrice.hidden = false;
      } else {
        checkoutManualOldPrice.hidden = true;
      }

      checkoutManualText.textContent = hasDiscount
        ? `Нажмите для оплаты — ${finalPrice} ${unit}`
        : `Нажмите для оплаты — ${basePrice} ${unit}`;
      return;
    }
  }

  checkoutManualOldPrice.hidden = true;
  checkoutManualText.textContent = manualConfig.buyLabel;
}

// Единая точка обновления всех цен на экране оформления — вызывается при
// смене тарифа, способа оплаты, а также при применении/снятии промокода,
// чтобы скидка сразу и везде: на карточках тарифа, на кнопке "Купить" и
// на кнопке ручной оплаты (RU карта).
function refreshAllPrices() {
  if (!checkoutProduct) return;
  refreshDurationPrices();
  updateBuyButtonLabel(checkoutBuyText, checkoutProduct, checkoutDuration);
  updateManualButtonLabel();
}

paymentOptions.addEventListener("click", (e) => {
  const btn = e.target.closest(".payment-option");
  if (!btn) return;

  setPaymentMethod(btn.dataset.method);
  setCardStatus(checkoutStatus, "");
  setPaymentOptionsOpen(false);
  tg?.HapticFeedback?.selectionChanged();
});

// Закрыть список способов оплаты по клику вне него.
document.addEventListener("click", (e) => {
  if (!paymentSelect.contains(e.target)) {
    setPaymentOptionsOpen(false);
  }
});

function showNftModal() {
  const manualConfig = MANUAL_PAYMENT_METHODS[checkoutPaymentMethod];
  if (manualConfig) {
    nftModalTitle.textContent = manualConfig.modalTitle;
    nftModalText.textContent = manualConfig.modalText;
  }

  nftModal.hidden = false;

  // Перезапускаем анимацию появления модалки без синхронного форсированного
  // reflow (void el.offsetHeight сразу в обработчике клика блокирует поток
  // на время пересчёта layout — на слабых устройствах это и ощущается как
  // "тормознутость" в момент открытия). Двойной requestAnimationFrame даёт
  // тот же гарантированный перезапуск именованной CSS-анимации, но не
  // блокирует поток синхронным чтением layout-свойства.
  [nftModalBackdrop, nftModal.querySelector(".nft-modal-card")].forEach((el) => {
    if (!el) return;
    el.style.animation = "none";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.animation = "";
      });
    });
  });
}

function hideNftModal() {
  nftModal.hidden = true;
}

checkoutManualBtn.addEventListener("click", () => {
  showNftModal();
  tg?.HapticFeedback?.selectionChanged();
});

nftModalCancel.addEventListener("click", () => {
  hideNftModal();
  tg?.HapticFeedback?.selectionChanged();
});

nftModalBackdrop.addEventListener("click", () => {
  hideNftModal();
});

nftModalWrite.addEventListener("click", () => {
  hideNftModal();
  // Открываем личные сообщения с нужным получателем в Telegram — у каждого
  // способа оплаты свой username (см. ownerUsername в MANUAL_PAYMENT_METHODS):
  // гривны идут администратору, NFT и RU карта — владельцу.
  // tg.openTelegramLink корректно работает внутри Mini App, window.open —
  // запасной вариант для случаев, когда приложение открыто вне Telegram.
  const manualConfig = MANUAL_PAYMENT_METHODS[checkoutPaymentMethod];
  const targetUsername = manualConfig?.ownerUsername || MANUAL_PAYMENT_OWNER_USERNAME;

  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/${targetUsername}`);
  } else {
    window.open(`https://t.me/${targetUsername}`, "_blank");
  }
  tg?.HapticFeedback?.selectionChanged();
});

// Элементы, у которых есть CSS-анимация появления, навешиваемая временным
// классом .co-anim-in (см. playCheckoutEntrance). Базовый CSS теперь всегда
// держит их видимыми (opacity: 1) — анимация лишь временно "занижает"
// opacity на время своего проигрывания, а не является единственным
// способом их показать.
const checkoutAnimatedEls = [
  viewCheckout.querySelector(".checkout-hero"),
  viewCheckout.querySelector(".gallery-card"),
  ...viewCheckout.querySelectorAll(".option-group"),
  checkoutBuyBtn,
  checkoutManualBtn,
].filter(Boolean);

let checkoutAnimSafetyTimer = null;

// Проигрывает анимацию появления карточек экрана оформления. Класс
// .co-anim-in снимается и добавляется заново при КАЖДОМ вызове (с reflow
// между ними), чтобы анимация гарантированно перезапускалась даже при
// повторном открытии одного и того же экрана — переключение класса
// надёжнее в Telegram WebView, чем просто display: none -> block.
//
// Плюс: если по какой-то причине анимация не доиграет и не снимет класс
// сама (animation-fill-mode: both держит финальный кадр, но мало ли),
// через небольшую страховочную паузу класс снимается принудительно —
// контент в любом случае останется видимым, потому что базовый CSS для
// этих элементов — opacity: 1, а не 0.
function playCheckoutEntrance() {
  checkoutAnimatedEls.forEach((el) => el.classList.remove("co-anim-in"));

  // Раньше здесь стоял `void viewCheckout.offsetHeight` — синхронный
  // форсированный reflow прямо в обработчике клика по карточке товара
  // (открытие оформления). Именно такие синхронные reflow в момент клика
  // и ощущались как "нажатие не сработало с первого раза": браузер сначала
  // должен был синхронно пересчитать layout всего экрана, и только потом
  // — обработать сам переход, из-за чего реакция на тап "запаздывала".
  // Двойной requestAnimationFrame даёт тот же гарантированный перезапуск
  // анимации без блокировки потока.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      checkoutAnimatedEls.forEach((el, index) => {
        el.style.animationDelay = `${index * 70 + 60}ms`;
        el.classList.add("co-anim-in");
      });
    });
  });

  clearTimeout(checkoutAnimSafetyTimer);
  checkoutAnimSafetyTimer = setTimeout(() => {
    checkoutAnimatedEls.forEach((el) => el.classList.remove("co-anim-in"));
  }, 900);
}

// Показывает выбранный скриншот в главном окне галереи.
function setGalleryMedia(src) {
  galleryMainImg.src = src;
}

galleryThumbs.querySelectorAll(".gallery-thumb").forEach((thumb) => {
  thumb.addEventListener("click", () => {
    galleryThumbs
      .querySelectorAll(".gallery-thumb")
      .forEach((el) => el.classList.remove("gallery-thumb--active"));
    thumb.classList.add("gallery-thumb--active");
    setGalleryMedia(thumb.dataset.mediaSrc);
    tg?.HapticFeedback?.selectionChanged();
  });
});

let checkoutProduct = null;
let checkoutDuration = DURATIONS[0].code;
let checkoutPromoCode = null;
let checkoutDiscountPercent = 0;

function openCheckout(product, prefillPromoCode) {
  playCheckoutEntrance();

  checkoutProduct = product;
  checkoutDuration = DURATIONS[0].code;
  checkoutPromoCode = null;
  checkoutDiscountPercent = 0;
  checkoutPromoInput.value = "";
  checkoutPromoApply.textContent = "Применить";
  checkoutPromoApply.classList.remove("promo-apply-btn--applied");
  checkoutPromoApply.disabled = false;
  checkoutPromoInput.disabled = false;
  setPromoStatus("");
  setPaymentMethod("stars");
  hideNftModal();

  checkoutTitle.textContent = product.title;
  checkoutInitial.src = product.logo || "";
  checkoutSubtitle.textContent = product.subtitle;

  // При каждом открытии оформления галерея сбрасывается на первый слайд
  // (скриншот), а не остаётся на видео, выбранном в прошлый раз.
  const firstThumb = galleryThumbs.querySelector(".gallery-thumb");
  galleryThumbs
    .querySelectorAll(".gallery-thumb")
    .forEach((el) => el.classList.remove("gallery-thumb--active"));
  if (firstThumb) {
    firstThumb.classList.add("gallery-thumb--active");
    setGalleryMedia(firstThumb.dataset.mediaSrc);
  }

  checkoutBadges.innerHTML = "";
  (product.badges || []).forEach((badgeText) => {
    const b = document.createElement("span");
    b.className = "badge-tag";
    b.textContent = badgeText;
    checkoutBadges.appendChild(b);
  });

  checkoutDurations.innerHTML = "";
  DURATIONS.forEach((duration, index) => {
    const dNode = durationTemplate.content.cloneNode(true);
    const dBtn = dNode.querySelector(".duration-option");
    dBtn.dataset.duration = duration.code;
    dBtn.classList.toggle("duration-option--selected", index === 0);
    dNode.querySelector(".duration-option-label").textContent = duration.label;
    applyDurationPrice(dNode.querySelector(".duration-option-price"), duration);
    checkoutDurations.appendChild(dNode);
  });

  checkoutBuyBtn.disabled = false;
  refreshAllPrices();
  setCardStatus(checkoutStatus, "");

  switchView("checkout");

  // Если экран открыт с уже готовым промокодом (например, по кнопке
  // "Использовать" из "Моих промокодов") — подставляем его в поле и сразу
  // проверяем/применяем через сервер, как при обычном ручном вводе.
  if (prefillPromoCode) {
    checkoutPromoInput.value = prefillPromoCode;
    applyPromoCode();
  }
}

checkoutDurations.addEventListener("click", (e) => {
  const btn = e.target.closest(".duration-option");
  if (!btn || !checkoutProduct) return;

  checkoutDurations.querySelectorAll(".duration-option").forEach((b) => {
    b.classList.toggle("duration-option--selected", b === btn);
  });

  checkoutDuration = btn.dataset.duration;
  refreshAllPrices();
  tg?.HapticFeedback?.selectionChanged();
});

async function applyPromoCode() {
  const rawCode = checkoutPromoInput.value.trim();

  if (!rawCode) {
    setPromoStatus("Введите промокод", "error");
    return;
  }

  checkoutPromoApply.disabled = true;
  setPromoStatus("Проверяем промокод...");

  let data;
  try {
    const response = await fetch(`/validate_promo?code=${encodeURIComponent(rawCode)}`);
    data = await response.json();
  } catch (err) {
    checkoutPromoApply.disabled = false;
    setPromoStatus("Не удалось проверить промокод, попробуй ещё раз", "error");
    return;
  }

  checkoutPromoApply.disabled = false;

  if (!data.valid) {
    checkoutPromoCode = null;
    checkoutDiscountPercent = 0;
    checkoutPromoApply.classList.remove("promo-apply-btn--applied");
    checkoutPromoApply.textContent = "Применить";
    checkoutPromoInput.disabled = false;
    setPromoStatus("Промокод не найден или уже использован", "error");
    refreshAllPrices();
    tg?.HapticFeedback?.notificationOccurred("error");
    return;
  }

  checkoutPromoCode = rawCode;
  checkoutDiscountPercent = data.discount_percent;
  checkoutPromoApply.textContent = "Применено";
  checkoutPromoApply.classList.add("promo-apply-btn--applied");
  checkoutPromoInput.disabled = true;
  setPromoStatus(`Скидка ${data.discount_percent}% применена`, "success");
  refreshAllPrices();
  tg?.HapticFeedback?.notificationOccurred("success");
}

checkoutPromoApply.addEventListener("click", () => {
  if (!checkoutProduct) return;

  // Повторный клик по уже применённому промокоду снимает его —
  // так пользователь может вернуться к полной цене.
  if (checkoutPromoCode) {
    checkoutPromoCode = null;
    checkoutDiscountPercent = 0;
    checkoutPromoInput.disabled = false;
    checkoutPromoInput.value = "";
    checkoutPromoApply.textContent = "Применить";
    checkoutPromoApply.classList.remove("promo-apply-btn--applied");
    setPromoStatus("");
    refreshAllPrices();
    return;
  }

  applyPromoCode();
});

checkoutPromoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyPromoCode();
  }
});

checkoutPromoInput.addEventListener("focus", () => {
  // Небольшая задержка нужна, чтобы клавиатура успела появиться и
  // визуальный вьюпорт пересчитался — иначе scrollIntoView сработает
  // по ещё не сжавшейся высоте и промахнётся.
  setTimeout(() => {
    checkoutPromoInput.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 300);
});

checkoutBuyBtn.addEventListener("click", () => {
  if (!checkoutProduct) return;
  handleBuy(checkoutProduct, checkoutDuration, checkoutBuyBtn, checkoutBuyText, checkoutStatus);
});

checkoutBack.addEventListener("click", () => {
  switchView("shop");
  tg?.HapticFeedback?.selectionChanged();
});

// ====== Вкладки ======
const tabs = document.querySelectorAll(".tab");
const views = {
  shop: document.getElementById("view-shop"),
  profile: document.getElementById("view-profile"),
  checkout: viewCheckout,
  case: document.getElementById("view-case"),
  mypromos: document.getElementById("view-mypromos"),
  admin: document.getElementById("view-admin"),
};

// Экраны, которые визуально являются "внутренними" для другого раздела —
// используются, чтобы подсвечивать правильную вкладку в таббаре, когда
// открыт не сам раздел, а вложенный в него экран.
const VIEW_PARENT_TAB = {
  checkout: "shop",
  case: "shop",
  mypromos: "profile",
};

function switchView(target) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("view--active", key === target);
  });

  // Подсвечиваем вкладку раздела-родителя, если открыт вложенный экран
  // (оформление/кейс — внутри "Магазина", мои промокоды — внутри "Профиля")
  const activeTabKey = VIEW_PARENT_TAB[target] || target;
  tabs.forEach((t) => t.classList.toggle("tab--active", t.dataset.view === activeTabKey));

  // Сбрасываем прокрутку контейнера .app в начало при каждом переключении
  // экрана. Раньше этого не было: если пользователь успевал прокрутить
  // страницу вниз, следующий открытый экран (например, чекаут) рендерился
  // корректно, но оказывался вне видимой области — выглядело так, будто
  // "интерфейс не открылся". Это и была причина бага "через раз".
  app.scrollTop = 0;

  // Гарантированно перезапускаем анимацию появления экрана: снимаем
  // класс, форсируем reflow, навешиваем заново. Без явного reflow между
  // remove и add браузер может "склеить" эти два изменения в одно и не
  // перезапустить одну и ту же именованную CSS-анимацию повторно — именно
  // это было причиной бага "первый раз открывается нормально, второй раз
  // экран будто не появляется пару секунд" (сам экран при этом уже виден
  // благодаря opacity: 1 по умолчанию, но без свежей анимации переход
  // выглядел "залипшим").
  // ВАЖНО: раньше здесь стоял `void activeView.offsetHeight;` сразу после
  // remove/перед add — это форсированный синхронный reflow (layout
  // thrashing) прямо в обработчике клика, да ещё сразу после записи
  // app.scrollTop = 0 и смены классов выше. Браузер был вынужден
  // синхронно пересчитать layout всей страницы в тот же тик — именно
  // это ощущалось как подлагивание/рывок в момент переключения вкладок.
  // Двойной requestAnimationFrame даёт тот же гарантированный перезапуск
  // именованной CSS-анимации (браузер успевает "увидеть" класс без
  // анимации на одном кадре и с анимацией на следующем), но не блокирует
  // основной поток синхронным чтением layout-свойства.
  const activeView = views[target];
  if (activeView) {
    activeView.classList.remove("view-anim-in");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        activeView.classList.add("view-anim-in");
      });
    });
  }
}

// Username поддержки — вкладка "Поддержка" в таббаре просто открывает
// личные сообщения с этим пользователем, без переключения экрана внутри
// мини-аппа (см. обработчик клика по вкладкам ниже).
const SUPPORT_USERNAME = "meaninglessperson";

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    // Вкладка "Поддержка" — особый случай: не меняем активный экран/вкладку
    // мини-аппа, а просто открываем личку с поддержкой и выходим из
    // обработчика. tg.openTelegramLink корректно работает внутри Mini App,
    // window.open — запасной вариант для случаев, когда приложение открыто
    // вне Telegram (см. такой же паттерн у nftModalWrite выше).
    if (tab.dataset.view === "support") {
      tg?.HapticFeedback?.selectionChanged();
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(`https://t.me/${SUPPORT_USERNAME}`);
      } else {
        window.open(`https://t.me/${SUPPORT_USERNAME}`, "_blank");
      }
      return;
    }

    switchView(tab.dataset.view);
    tg?.HapticFeedback?.selectionChanged();
    if (tab.dataset.view === "admin") {
      loadBannedList();
      loadAdminPromos();
      if (isOwnerUser) loadAdminsList();
    }
  });
});

// ====== Прогрев скрытых вкладок и шрифтов (фикс задержки при первом входе) ======
// Раньше "Мои промокоды", "Оформление заказа" и "Кейс" были скрыты через
// display: none и браузер вообще не считал для них стили/раскладку и не
// подгружал нужные жирные начертания шрифта — всё это происходило только
// в момент реального открытия вкладки, поэтому иногда интерфейс появлялся
// не сразу, а через пару секунд после клика. Теперь мы один раз, ещё пока
// показан сплэш, ненадолго и невидимо (visibility: hidden, вне потока
// документа) показываем эти экраны — браузер успевает посчитать всё
// заранее, и реальное открытие вкладки происходит мгновенно.
function warmUpHiddenViews() {
  const hiddenViews = Object.entries(views)
    .filter(([key]) => key !== "shop")
    .map(([, el]) => el)
    .filter(Boolean);

  hiddenViews.forEach((el) => {
    el.style.display = "block";
    el.style.visibility = "hidden";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
  });

  // Форсируем расчёт layout прямо сейчас, а не откладываем его на потом
  void document.body.offsetHeight;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hiddenViews.forEach((el) => {
        el.style.display = "";
        el.style.visibility = "";
        el.style.position = "";
        el.style.pointerEvents = "";
      });
    });
  });
}

// Заранее догружаем начертания шрифта, которые реально используются в
// заголовках/бейджах на этих вкладках — иначе первая отрисовка текста
// такой жирности ждёт сетевой запрос к Google Fonts.
function preloadFonts() {
  if (!document.fonts || !document.fonts.load) return;
  ["600 16px 'Golos Text'", "700 16px 'Golos Text'", "800 16px 'Golos Text'", "900 16px 'Golos Text'"]
    .forEach((font) => document.fonts.load(font).catch(() => {}));
}

warmUpHiddenViews();
preloadFonts();

// ====== Профиль ======
const profileAvatar = document.getElementById("profileAvatar");
const profileAvatarFallback = document.getElementById("profileAvatarFallback");
const profileAvatarLetter = document.getElementById("profileAvatarLetter");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");
const adminTabBtn = document.getElementById("adminTabBtn");

// Простая иконка пользователя — показывается, если у нас вообще нет
// данных о человеке (не открыто из Telegram)
const GUEST_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>`;

function showAvatarFallback(letterOrIcon) {
  profileAvatar.hidden = true;
  profileAvatar.removeAttribute("src");
  profileAvatarFallback.hidden = false;
  profileAvatarLetter.innerHTML = letterOrIcon;
}

function fillProfileFromTelegram() {
  const user = tg?.initDataUnsafe?.user;

  // Вкладка "Админ" видна владельцу и всем назначенным им админам.
  // Проверка тут — просто чтобы не показывать её случайным людям в
  // интерфейсе; реальные права на любое действие всё равно
  // перепроверяются на сервере по подписанному initData.
  checkAdminAccess();

  if (!user) {
    profileName.textContent = "Гость";
    profileUsername.textContent = "Открой из Telegram";
    showAvatarFallback(GUEST_ICON_SVG);
    return;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  profileName.textContent = fullName || "Без имени";
  profileUsername.textContent = user.username ? "@" + user.username : "Без ника";

  const firstLetter = (user.first_name || user.username || "?").charAt(0).toUpperCase();

  if (user.photo_url) {
    loadAvatarImage(user.photo_url, firstLetter);
  } else {
    // photo_url не всегда доступен в initData из соображений приватности —
    // пробуем получить фото через бэкенд (бот умеет запрашивать его у Telegram)
    loadAvatarImage(`/avatar?user_id=${user.id}`, firstLetter);
  }
}

function loadAvatarImage(src, fallbackLetter) {
  // Показываем букву сразу, чтобы не было пустоты, пока грузится фото
  showAvatarFallback(fallbackLetter);

  const testImg = new Image();
  testImg.onload = () => {
    profileAvatar.src = src;
    profileAvatar.hidden = false;
    profileAvatarFallback.hidden = true;
  };
  testImg.onerror = () => {
    // Фото недоступно — так и оставляем аккуратный фолбэк с буквой
    showAvatarFallback(fallbackLetter);
  };
  testImg.src = src;
}

// ====== Мои промокоды (профиль) ======
const myPromosBtn = document.getElementById("myPromosBtn");
const myPromosBack = document.getElementById("myPromosBack");
const promoList = document.getElementById("promoList");
const promoListEmpty = document.getElementById("promoListEmpty");
const promoListActions = document.getElementById("promoListActions");
const promoSelectModeBtn = document.getElementById("promoSelectModeBtn");
const promoCancelSelectBtn = document.getElementById("promoCancelSelectBtn");
const promoDeleteSelectedBtn = document.getElementById("promoDeleteSelectedBtn");
const promoSelectedCount = document.getElementById("promoSelectedCount");
const promoDeleteAllBtn = document.getElementById("promoDeleteAllBtn");

// Определяет визуальную "редкость" промокода — та же логика, что и для
// призов кейса, чтобы бирки выглядели одинаково по всему приложению.
function promoRarityKeyFor(discountPercent) {
  if (discountPercent >= 50) return "legendary";
  if (discountPercent >= 30) return "epic";
  if (discountPercent >= 15) return "rare";
  if (discountPercent >= 10) return "uncommon";
  return "common";
}

function setPromoListEmpty(text) {
  promoListEmpty.textContent = text;
  promoListEmpty.hidden = false;
}

// Переносит пользователя на экран оформления единственного товара с уже
// подставленным и применённым промокодом — код при этом всё ещё проверяется
// сервером через /validate_promo, как и при ручном вводе.
function useMyPromoCode(code) {
  const product = PRODUCTS[0];
  if (!product) return;
  openCheckout(product, code);
}

// Текущий список загруженных кодов и выбранные для удаления — хранится
// отдельно от DOM, чтобы удобно фильтровать/пересчитывать счётчик.
let myPromoCodes = [];
let selectedPromoCodes = new Set();
let isSelectingPromos = false;

function updatePromoSelectionUI() {
  const count = selectedPromoCodes.size;
  promoSelectedCount.textContent = String(count);
  promoDeleteSelectedBtn.disabled = count === 0;

  promoList.querySelectorAll(".promo-list-item").forEach((row) => {
    const code = row.dataset.code;
    row.classList.toggle("promo-list-item--selected", selectedPromoCodes.has(code));
    const checkbox = row.querySelector(".promo-item-checkbox");
    if (checkbox) checkbox.checked = selectedPromoCodes.has(code);
  });
}

function enterPromoSelectMode() {
  if (!myPromoCodes.length) return;
  isSelectingPromos = true;
  selectedPromoCodes.clear();
  promoList.classList.add("promo-list--selecting");
  promoSelectModeBtn.hidden = true;
  promoDeleteAllBtn.hidden = true;
  promoDeleteSelectedBtn.hidden = false;
  promoCancelSelectBtn.hidden = false;
  updatePromoSelectionUI();
}

function exitPromoSelectMode() {
  isSelectingPromos = false;
  selectedPromoCodes.clear();
  promoList.classList.remove("promo-list--selecting");
  promoSelectModeBtn.hidden = false;
  promoDeleteAllBtn.hidden = false;
  promoDeleteSelectedBtn.hidden = true;
  promoCancelSelectBtn.hidden = true;
  updatePromoSelectionUI();
}

function togglePromoSelected(code) {
  if (selectedPromoCodes.has(code)) {
    selectedPromoCodes.delete(code);
  } else {
    selectedPromoCodes.add(code);
  }
  updatePromoSelectionUI();
}

function renderMyPromoCodes(codes) {
  myPromoCodes = codes;
  promoList.innerHTML = "";

  if (!codes.length) {
    setPromoListEmpty("Пока нет неиспользованных промокодов — открой кейс в магазине, чтобы получить скидку.");
    promoListActions.hidden = true;
    exitPromoSelectMode();
    return;
  }

  promoListEmpty.hidden = true;
  promoListActions.hidden = false;

  codes.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "promo-list-item";
    row.style.setProperty("--promo-index", index);
    row.dataset.code = item.code;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "promo-list-item-checkbox promo-item-checkbox";
    checkbox.setAttribute("aria-label", "Выбрать промокод " + item.code);
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => {
      togglePromoSelected(item.code);
      tg?.HapticFeedback?.selectionChanged();
    });

    const badge = document.createElement("span");
    badge.className = "promo-list-item-badge promo-badge--" + promoRarityKeyFor(item.discount_percent);
    badge.textContent = `-${item.discount_percent}%`;

    const codeText = document.createElement("span");
    codeText.className = "promo-list-item-code";
    codeText.textContent = item.code;

    const useBtn = document.createElement("button");
    useBtn.className = "promo-list-item-use-btn";
    useBtn.type = "button";
    useBtn.textContent = "Использовать";
    useBtn.addEventListener("click", () => {
      if (isSelectingPromos) {
        togglePromoSelected(item.code);
        tg?.HapticFeedback?.selectionChanged();
        return;
      }
      useMyPromoCode(item.code);
      tg?.HapticFeedback?.selectionChanged();
    });

    row.appendChild(checkbox);
    row.appendChild(badge);
    row.appendChild(codeText);
    row.appendChild(useBtn);

    // В режиме выбора клик по всей строке тоже переключает чекбокс —
    // не нужно целиться точно в маленький квадратик.
    row.addEventListener("click", () => {
      if (!isSelectingPromos) return;
      checkbox.checked = !checkbox.checked;
      togglePromoSelected(item.code);
      tg?.HapticFeedback?.selectionChanged();
    });

    promoList.appendChild(row);
  });

  updatePromoSelectionUI();
}

async function loadMyPromoCodes() {
  promoList.innerHTML = "";
  promoListEmpty.hidden = true;
  exitPromoSelectMode();

  try {
    const response = await fetch("/my_promo_codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg ? tg.initData : "" }),
    });

    if (!response.ok) throw new Error("bad response");
    const data = await response.json();
    renderMyPromoCodes(data.codes || []);
  } catch (err) {
    promoListActions.hidden = true;
    setPromoListEmpty("Не удалось загрузить промокоды, попробуй ещё раз позже.");
  }
}

// Общий помощник для запроса подтверждения — использует нативный диалог
// Telegram Mini App, если он доступен, иначе обычный confirm() браузера.
function confirmAction(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) {
      tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
    } else {
      resolve(window.confirm(message));
    }
  });
}

async function deleteSelectedPromoCodes() {
  const codes = Array.from(selectedPromoCodes);
  if (!codes.length) return;

  const confirmed = await confirmAction(
    codes.length === 1
      ? "Удалить выбранный промокод?"
      : `Удалить выбранные промокоды (${codes.length})?`
  );
  if (!confirmed) return;

  promoDeleteSelectedBtn.disabled = true;
  try {
    const response = await fetch("/delete_promo_codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg ? tg.initData : "", codes }),
    });
    if (!response.ok) throw new Error("bad response");
    tg?.HapticFeedback?.notificationOccurred("success");
    await loadMyPromoCodes();
  } catch (err) {
    tg?.HapticFeedback?.notificationOccurred("error");
    setPromoListEmpty("Не удалось удалить промокоды, попробуй ещё раз позже.");
  }
}

async function deleteAllPromoCodes() {
  if (!myPromoCodes.length) return;

  const confirmed = await confirmAction("Удалить все промокоды без возможности восстановления?");
  if (!confirmed) return;

  promoDeleteAllBtn.disabled = true;
  try {
    const response = await fetch("/delete_all_promo_codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg ? tg.initData : "" }),
    });
    if (!response.ok) throw new Error("bad response");
    tg?.HapticFeedback?.notificationOccurred("success");
    await loadMyPromoCodes();
  } catch (err) {
    tg?.HapticFeedback?.notificationOccurred("error");
    setPromoListEmpty("Не удалось удалить промокоды, попробуй ещё раз позже.");
  } finally {
    promoDeleteAllBtn.disabled = false;
  }
}

promoSelectModeBtn.addEventListener("click", () => {
  enterPromoSelectMode();
  tg?.HapticFeedback?.selectionChanged();
});

promoCancelSelectBtn.addEventListener("click", () => {
  exitPromoSelectMode();
  tg?.HapticFeedback?.selectionChanged();
});

promoDeleteSelectedBtn.addEventListener("click", () => {
  deleteSelectedPromoCodes();
});

promoDeleteAllBtn.addEventListener("click", () => {
  deleteAllPromoCodes();
});

myPromosBtn.addEventListener("click", () => {
  switchView("mypromos");
  loadMyPromoCodes();
  tg?.HapticFeedback?.selectionChanged();
});

myPromosBack.addEventListener("click", () => {
  switchView("profile");
  tg?.HapticFeedback?.selectionChanged();
});

// ====== Кейс с промокодом ======
const caseEntryCard = document.getElementById("caseEntryCard");
const caseBack = document.getElementById("caseBack");
const caseStage = document.getElementById("caseStage");
const caseOpenBtn = document.getElementById("caseOpenBtn");
const caseResult = document.getElementById("caseResult");
const caseResultBadge = document.getElementById("caseResultBadge");
const caseResultCode = document.getElementById("caseResultCode");
const caseCopyBtn = document.getElementById("caseCopyBtn");
const caseAgainBtn = document.getElementById("caseAgainBtn");
const caseStatus = document.getElementById("caseStatus");
const caseReelWrap = document.getElementById("caseReelWrap");
const caseReelTrack = document.getElementById("caseReelTrack");
const casePrizeModal = document.getElementById("casePrizeModal");
const casePrizeModalBackdrop = document.getElementById("casePrizeModalBackdrop");
const casePrizeModalBadge = document.getElementById("casePrizeModalBadge");
const casePrizeModalCode = document.getElementById("casePrizeModalCode");
const casePrizeModalOk = document.getElementById("casePrizeModalOk");

// Значения приза только для визуального наполнения рулетки декоями —
// реальный приз всегда приходит с сервера (см. /open_case в bot.py),
// клиент его не выбирает и не может повлиять на результат.
const CASE_REEL_VALUES = [3, 5, 10, 15, 30, 50];
const CASE_REEL_DECOYS_BEFORE = 28;
const CASE_REEL_DECOYS_AFTER = 6;
const CASE_SPIN_DURATION_MS = 3200;

// Кейс снова платный — цена должна совпадать с CASE_PRICE_STARS в bot.py.
const CASE_PRICE_STARS = 60;
const CASE_OPEN_BTN_LABEL = `Открыть кейс — 60 ${STAR_ICON_SVG}`;

// Сколько раз и с каким интервалом опрашивать /claim_case_reward после
// того, как Telegram сообщил статус оплаты "paid" — реальный приз
// "крутится" на сервере в момент successful_payment, который приходит
// боту чуть позже, чем колбэк tg.openInvoice в мини-аппе.
const CASE_CLAIM_POLL_INTERVAL_MS = 700;
const CASE_CLAIM_POLL_ATTEMPTS = 20;

function setCaseStatus(text, type = "") {
  caseStatus.textContent = text;
  caseStatus.className = "case-status" + (type ? " " + type : "");
}

// Определяет визуальную "редкость" приза — чисто для оформления карточки
function rarityKeyFor(discountPercent) {
  if (discountPercent >= 50) return "legendary";
  if (discountPercent >= 30) return "epic";
  if (discountPercent >= 15) return "rare";
  if (discountPercent >= 10) return "uncommon";
  return "common";
}

function rarityClassFor(discountPercent) {
  return "case-result-badge--" + rarityKeyFor(discountPercent);
}

function buildReelItem(value) {
  const el = document.createElement("div");
  el.className = "case-reel-item case-reel-item--" + rarityKeyFor(value);
  el.textContent = `-${value}%`;
  return el;
}

// Полностью сбрасывает экран кейса в исходное состояние — вызывается
// каждый раз перед переходом на этот экран, чтобы предыдущий результат
// не "мигал" на секунду, пока не откроется свежий кейс.
function resetCaseStage() {
  caseReelWrap.hidden = true;
  caseReelTrack.innerHTML = "";
  caseReelTrack.style.transition = "none";
  caseReelTrack.style.transform = "translateX(0px)";
  caseResult.hidden = true;
  caseAgainBtn.hidden = true;
  caseStage.classList.remove("case-stage--spinning", "case-stage--opened");
  caseOpenBtn.hidden = false;
  caseOpenBtn.disabled = false;
  caseOpenBtn.innerHTML = CASE_OPEN_BTN_LABEL;
  setCaseStatus("");
  hideCasePrizeModal();
}

// Показывает мини-меню с полученным промокодом поверх экрана кейса —
// появляется сразу после того, как рулетка докрутилась до приза.
function showCasePrizeModal(discountPercent, code) {
  casePrizeModalBadge.textContent = `-${discountPercent}%`;
  casePrizeModalBadge.className = "case-prize-modal-badge " + rarityClassFor(discountPercent);
  casePrizeModalCode.textContent = code;
  casePrizeModal.hidden = false;

  // Форсируем перезапуск анимации появления при каждом открытии кейса —
  // без этого при повторном открытии (второй, третий раз за сессию)
  // анимация backdrop/карточки могла не запуститься заново в Telegram
  // WebView (тот же приём, что и для .case-result чуть выше по коду).
  [casePrizeModalBackdrop, casePrizeModal.querySelector(".case-prize-modal-card")].forEach((el) => {
    if (!el) return;
    el.style.animation = "none";
    // Двойной rAF вместо синхронного void el.offsetHeight — см. подробное
    // объяснение у showNftModal() выше: та же логика, тот же выигрыш.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.animation = "";
      });
    });
  });
}

function hideCasePrizeModal() {
  casePrizeModal.hidden = true;
}

casePrizeModalOk.addEventListener("click", () => {
  hideCasePrizeModal();
  tg?.HapticFeedback?.selectionChanged();
});

casePrizeModalBackdrop.addEventListener("click", () => {
  hideCasePrizeModal();
});

// Строит длинную ленту призов со случайными "декоями" и настоящим призом
// (discountPercent) где-то в середине, затем плавно прокручивает её так,
// чтобы приз точно остановился под указателем по центру — как в открытии
// кейсов в играх. Итог целиком определяется сервером ДО начала прокрутки,
// анимация лишь визуализирует уже известный результат.
function spinReelTo(discountPercent) {
  const items = [];
  for (let i = 0; i < CASE_REEL_DECOYS_BEFORE; i++) {
    items.push(CASE_REEL_VALUES[Math.floor(Math.random() * CASE_REEL_VALUES.length)]);
  }

  // "Почти повезло": если реально выпал небольшой приз (5% или 10%),
  // ставим крупный приз (30% или 50%) прямо ПЕРЕД финальной позицией —
  // рулетка визуально проезжает мимо джекпота и останавливается чуть
  // раньше, на настоящем (небольшом) призе. Сам результат при этом никак
  // не меняется — это чисто визуальный штрих ленты, приз всегда решён
  // сервером заранее.
  if (discountPercent === 3 || discountPercent === 5 || discountPercent === 10) {
    const nearValue = Math.random() < 0.5 ? 30 : 50;
    items[items.length - 1] = nearValue;
  }

  const targetIndex = items.length;
  items.push(discountPercent);
  for (let i = 0; i < CASE_REEL_DECOYS_AFTER; i++) {
    items.push(CASE_REEL_VALUES[Math.floor(Math.random() * CASE_REEL_VALUES.length)]);
  }

  caseReelTrack.innerHTML = "";
  caseReelTrack.style.transition = "none";
  caseReelTrack.style.transform = "translateX(0px)";

  items.forEach((value) => {
    caseReelTrack.appendChild(buildReelItem(value));
  });

  // Reflow, чтобы браузер точно применил сброс transform перед тем, как
  // мы запустим анимацию к новой позиции — иначе переход может "слипнуться"
  // со сбросом и визуально не сыграть.
  void caseReelTrack.offsetWidth;

  const wrapWidth = caseReelWrap.clientWidth;
  const targetEl = caseReelTrack.children[targetIndex];
  const itemCenter = targetEl.offsetLeft + targetEl.offsetWidth / 2;
  // Небольшой случайный сдвиг в пределах ширины плашки приза, чтобы
  // рулетка не останавливалась каждый раз идеально по центру — так
  // выглядит естественнее.
  const jitter = (Math.random() - 0.5) * (targetEl.offsetWidth * 0.5);
  const offset = itemCenter + jitter - wrapWidth / 2;

  requestAnimationFrame(() => {
    caseReelTrack.style.transition = `transform ${CASE_SPIN_DURATION_MS}ms cubic-bezier(0.1, 0.82, 0.13, 1)`;
    caseReelTrack.style.transform = `translateX(${-offset}px)`;
  });
}

// Ждёт, пока сервер "прокрутит" приз после подтверждённой оплаты
// (см. successful_payment_handler в bot.py), опрашивая /claim_case_reward.
// Оплата подтверждается ботом асинхронно (через successful_payment), а не
// прямо в колбэке tg.openInvoice, поэтому сразу после статуса "paid"
// приза может ещё не быть — отсюда и короткие повторные попытки.
async function pollCaseReward() {
  for (let attempt = 0; attempt < CASE_CLAIM_POLL_ATTEMPTS; attempt++) {
    const response = await fetch("/claim_case_reward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg ? tg.initData : "" }),
    });
    if (response.ok) {
      const data = await response.json();
      if (data.ready) return data;
    }
    await new Promise((resolve) => setTimeout(resolve, CASE_CLAIM_POLL_INTERVAL_MS));
  }
  return null;
}

async function openCase() {
  if (!tg) {
    setCaseStatus("Открой это приложение внутри Telegram", "error");
    return;
  }

  caseOpenBtn.disabled = true;
  caseOpenBtn.textContent = "Открываем оплату...";
  setCaseStatus("");

  let invoiceLink;
  try {
    const response = await fetch("/create_case_invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg.initData }),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error === "banned" ? "Вы забанены" : "Не удалось создать оплату");
    }
    const data = await response.json();
    invoiceLink = data.invoice_link;
  } catch (err) {
    caseOpenBtn.disabled = false;
    caseOpenBtn.innerHTML = CASE_OPEN_BTN_LABEL;
    setCaseStatus(err.message || "Не удалось открыть оплату, попробуй ещё раз", "error");
    return;
  }

  tg.openInvoice(invoiceLink, async (status) => {
    if (status !== "paid") {
      caseOpenBtn.disabled = false;
      caseOpenBtn.innerHTML = CASE_OPEN_BTN_LABEL;
      if (status === "cancelled") {
        setCaseStatus("Оплата отменена");
      } else if (status === "failed") {
        setCaseStatus("Оплата не прошла", "error");
      } else {
        setCaseStatus("Статус: " + status);
      }
      return;
    }

    caseOpenBtn.hidden = true;
    caseResult.hidden = true;
    caseAgainBtn.hidden = true;
    setCaseStatus("Оплата прошла, крутим кейс...");
    caseStage.classList.add("case-stage--spinning");
    caseReelWrap.hidden = false;

    try {
      const reward = await pollCaseReward();
      if (!reward) {
        throw new Error("Оплата прошла, но приз пока не пришёл — открой «Мои промокоды» через минуту");
      }

      spinReelTo(reward.discount_percent);
      tg?.HapticFeedback?.selectionChanged();

      // Ждём, пока рулетка реально докрутится до приза, и только потом
      // показываем карточку результата — иначе она появится раньше, чем
      // прокрутка остановится, и будет выглядеть рассинхронизированно.
      await new Promise((resolve) => setTimeout(resolve, CASE_SPIN_DURATION_MS));

      caseResultBadge.textContent = `-${reward.discount_percent}%`;
      caseResultBadge.className = "case-result-badge " + rarityClassFor(reward.discount_percent);
      caseResultCode.textContent = reward.code;

      caseCopyBtn.textContent = "Скопировать";
      caseCopyBtn.classList.remove("case-copy-btn--copied");

      caseResult.hidden = false;
      caseResult.style.animation = "none";
      // Двойной rAF вместо синхронного reflow — тот же приём, что и выше.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      caseResult.style.animation = "";
      caseAgainBtn.hidden = false;

      caseReelWrap.hidden = true;
      caseStage.classList.remove("case-stage--spinning");
      caseStage.classList.add("case-stage--opened");

      setCaseStatus("Промокод действует на одну покупку — вставь его на экране оформления", "success");
      tg?.HapticFeedback?.notificationOccurred("success");

      // Мини-меню с промокодом поверх экрана — появляется сразу после того,
      // как кнопка "Открыть кейс ещё раз" уже видна.
      showCasePrizeModal(reward.discount_percent, reward.code);
    } catch (err) {
      caseReelWrap.hidden = true;
      caseStage.classList.remove("case-stage--spinning");
      caseOpenBtn.hidden = false;
      setCaseStatus(err.message || "Не удалось открыть кейс, попробуй ещё раз", "error");
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally {
      caseOpenBtn.disabled = false;
      caseOpenBtn.innerHTML = CASE_OPEN_BTN_LABEL;
    }
  });
}

caseEntryCard.addEventListener("click", () => {
  resetCaseStage();
  switchView("case");
  tg?.HapticFeedback?.selectionChanged();
});

caseBack.addEventListener("click", () => {
  hideCasePrizeModal();
  switchView("shop");
  tg?.HapticFeedback?.selectionChanged();
});

caseOpenBtn.addEventListener("click", () => {
  openCase();
  tg?.HapticFeedback?.selectionChanged();
});

caseAgainBtn.addEventListener("click", () => {
  resetCaseStage();
  openCase();
  tg?.HapticFeedback?.selectionChanged();
});

caseCopyBtn.addEventListener("click", async () => {
  const code = caseResultCode.textContent;
  try {
    await navigator.clipboard.writeText(code);
  } catch (err) {
    // Clipboard API недоступен (например, нет HTTPS) — просто выделяем текст,
    // чтобы пользователь мог скопировать вручную
    const range = document.createRange();
    range.selectNodeContents(caseResultCode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  caseCopyBtn.textContent = "Скопировано";
  caseCopyBtn.classList.add("case-copy-btn--copied");
  tg?.HapticFeedback?.selectionChanged();
});


// ====== Админ-панель ======
// Все запросы этого блока идут с init_data, и сервер САМ перепроверяет,
// что это действительно ADMIN_ID (см. is_admin_init_data в bot.py) —
// поэтому даже если кто-то откроет вкладку в обход (например, вручную
// вызвав switchView в консоли), никакое действие всё равно не пройдёт.

const adminManageBlock = document.getElementById("adminManageBlock");
const adminAddInput = document.getElementById("adminAddInput");
const adminAddBtn = document.getElementById("adminAddBtn");
const adminAddStatus = document.getElementById("adminAddStatus");
const adminAdminsList = document.getElementById("adminAdminsList");
const adminAdminsEmpty = document.getElementById("adminAdminsEmpty");

const adminBanInput = document.getElementById("adminBanInput");
const adminBanBtn = document.getElementById("adminBanBtn");
const adminBanStatus = document.getElementById("adminBanStatus");
const adminBannedList = document.getElementById("adminBannedList");
const adminBannedEmpty = document.getElementById("adminBannedEmpty");

const adminPromoCode = document.getElementById("adminPromoCode");
const adminPromoDiscount = document.getElementById("adminPromoDiscount");
const adminPromoActivations = document.getElementById("adminPromoActivations");
const adminPromoCreateBtn = document.getElementById("adminPromoCreateBtn");
const adminPromoStatus = document.getElementById("adminPromoStatus");
const adminPromoList = document.getElementById("adminPromoList");
const adminPromoEmpty = document.getElementById("adminPromoEmpty");

const adminUserPromoInput = document.getElementById("adminUserPromoInput");
const adminUserPromoBtn = document.getElementById("adminUserPromoBtn");
const adminUserPromoStatus = document.getElementById("adminUserPromoStatus");
const adminUserPromoList = document.getElementById("adminUserPromoList");
const adminUserPromoEmpty = document.getElementById("adminUserPromoEmpty");

// Иконка "крестик" для кнопок удаления/разбана в списках
const REMOVE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>`;

function setAdminStatus(el, text, type = "") {
  el.textContent = text;
  el.className = "promo-status" + (type ? " " + type : "");
}

async function adminPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: tg ? tg.initData : "", ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Ошибка запроса");
  }
  return data;
}

// --- Доступ к админ-панели ---

// true, если текущий пользователь — владелец (ADMIN_ID). Только владелец
// видит и может пользоваться блоком "Назначить админа" ниже. Обычные
// назначенные админы видят остальную панель (бан, промокоды), но не
// управление списком админов — это решает сервер по initData.
let isOwnerUser = false;

async function checkAdminAccess() {
  try {
    const data = await adminPost("/admin/whoami", {});
    adminTabBtn.hidden = !data.is_admin;
    isOwnerUser = !!data.is_owner;
    adminManageBlock.hidden = !isOwnerUser;
    if (isOwnerUser) loadAdminsList();
  } catch (err) {
    // Открыто не из Telegram или initData ещё не готова — просто не
    // показываем вкладку "Админ".
    adminTabBtn.hidden = true;
  }
}

// --- Назначение/снятие админов (только владелец) ---

async function loadAdminsList() {
  try {
    const data = await adminPost("/admin/admins/list", {});
    renderAdminsList(data.admins || []);
  } catch (err) {
    // см. комментарий в loadBannedList
  }
}

function renderAdminsList(items) {
  adminAdminsList.innerHTML = "";
  adminAdminsEmpty.hidden = items.length > 0;

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "admin-list-item";

    const info = document.createElement("div");
    info.className = "admin-list-item-info";

    const title = document.createElement("div");
    title.className = "admin-list-item-title";
    title.textContent = item.username ? "@" + item.username : `id ${item.user_id}`;

    const sub = document.createElement("div");
    sub.className = "admin-list-item-sub";
    sub.textContent = item.user_id && item.username ? `id ${item.user_id}` : "админ";

    info.appendChild(title);
    info.appendChild(sub);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "admin-list-item-remove";
    removeBtn.innerHTML = REMOVE_ICON_SVG;
    removeBtn.addEventListener("click", () => removeAdmin(item.key));

    row.appendChild(info);
    row.appendChild(removeBtn);
    adminAdminsList.appendChild(row);
  });
}

async function removeAdmin(key) {
  try {
    await adminPost("/admin/admins/remove", { key });
    tg?.HapticFeedback?.selectionChanged();
    loadAdminsList();
  } catch (err) {
    setAdminStatus(adminAddStatus, "Не удалось снять админа, попробуй ещё раз", "error");
  }
}

adminAddBtn.addEventListener("click", async () => {
  const target = adminAddInput.value.trim();
  if (!target) {
    setAdminStatus(adminAddStatus, "Введи username или id", "error");
    return;
  }

  adminAddBtn.disabled = true;
  try {
    await adminPost("/admin/admins/add", { target });
    adminAddInput.value = "";
    setAdminStatus(adminAddStatus, "Админ назначен", "success");
    tg?.HapticFeedback?.notificationOccurred("success");
    loadAdminsList();
  } catch (err) {
    let message = "Не удалось назначить: " + err.message;
    if (err.message === "already admin") message = "Этот пользователь уже назначен админом";
    if (err.message === "already owner") message = "Это и так владелец";
    setAdminStatus(adminAddStatus, message, "error");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    adminAddBtn.disabled = false;
  }
});

// --- Бан пользователей ---

async function loadBannedList() {
  try {
    const data = await adminPost("/admin/banned_list", {});
    renderBannedList(data.banned || []);
  } catch (err) {
    // Тихо игнорируем — например, если вкладка на секунду открылась не у
    // админа (initData ещё не готова при самом первом рендере).
  }
}

function renderBannedList(items) {
  adminBannedList.innerHTML = "";
  adminBannedEmpty.hidden = items.length > 0;

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "admin-list-item";

    const info = document.createElement("div");
    info.className = "admin-list-item-info";

    const title = document.createElement("div");
    title.className = "admin-list-item-title";
    title.textContent = item.username ? "@" + item.username : `id ${item.user_id}`;

    const sub = document.createElement("div");
    sub.className = "admin-list-item-sub";
    sub.textContent = item.user_id && item.username ? `id ${item.user_id}` : "забанен";

    info.appendChild(title);
    info.appendChild(sub);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "admin-list-item-remove";
    removeBtn.innerHTML = REMOVE_ICON_SVG;
    removeBtn.addEventListener("click", () => unbanUser(item.key));

    row.appendChild(info);
    row.appendChild(removeBtn);
    adminBannedList.appendChild(row);
  });
}

async function unbanUser(key) {
  try {
    await adminPost("/admin/unban", { key });
    tg?.HapticFeedback?.selectionChanged();
    loadBannedList();
  } catch (err) {
    setAdminStatus(adminBanStatus, "Не удалось разбанить, попробуй ещё раз", "error");
  }
}

adminBanBtn.addEventListener("click", async () => {
  const target = adminBanInput.value.trim();
  if (!target) {
    setAdminStatus(adminBanStatus, "Введи username или id", "error");
    return;
  }

  adminBanBtn.disabled = true;
  try {
    await adminPost("/admin/ban", { target });
    adminBanInput.value = "";
    setAdminStatus(adminBanStatus, "Пользователь забанен", "success");
    tg?.HapticFeedback?.notificationOccurred("success");
    loadBannedList();
  } catch (err) {
    const message = err.message === "already banned"
      ? "Этот пользователь уже забанен"
      : "Не удалось забанить: " + err.message;
    setAdminStatus(adminBanStatus, message, "error");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    adminBanBtn.disabled = false;
  }
});

// --- Промокоды ---

async function loadAdminPromos() {
  try {
    const data = await adminPost("/admin/promo/list", {});
    renderAdminPromos(data.promos || []);
  } catch (err) {
    // см. комментарий в loadBannedList
  }
}

function renderAdminPromos(items) {
  adminPromoList.innerHTML = "";
  adminPromoEmpty.hidden = items.length > 0;

  items.forEach((promo) => {
    const row = document.createElement("div");
    row.className = "admin-list-item";

    const info = document.createElement("div");
    info.className = "admin-list-item-info";

    const title = document.createElement("div");
    title.className = "admin-list-item-title";
    title.textContent = promo.code;

    const sub = document.createElement("div");
    sub.className = "admin-list-item-sub";
    sub.textContent = `Активировано ${promo.activations} из ${promo.max_activations}`;

    info.appendChild(title);
    info.appendChild(sub);

    const badge = document.createElement("span");
    badge.className = "admin-list-item-badge";
    badge.textContent = `-${promo.discount_percent}%`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "admin-list-item-remove";
    removeBtn.innerHTML = REMOVE_ICON_SVG;
    removeBtn.addEventListener("click", () => deleteAdminPromo(promo.code));

    row.appendChild(info);
    row.appendChild(badge);
    row.appendChild(removeBtn);
    adminPromoList.appendChild(row);
  });
}

async function deleteAdminPromo(code) {
  try {
    await adminPost("/admin/promo/delete", { code });
    tg?.HapticFeedback?.selectionChanged();
    loadAdminPromos();
  } catch (err) {
    setAdminStatus(adminPromoStatus, "Не удалось удалить промокод", "error");
  }
}

adminPromoCreateBtn.addEventListener("click", async () => {
  const code = adminPromoCode.value.trim();
  const discountPercent = parseInt(adminPromoDiscount.value, 10);
  const maxActivations = parseInt(adminPromoActivations.value, 10);

  if (!code) {
    setAdminStatus(adminPromoStatus, "Введи название промокода", "error");
    return;
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 1 || discountPercent > 100) {
    setAdminStatus(adminPromoStatus, "Скидка должна быть от 1 до 100%", "error");
    return;
  }
  if (!Number.isFinite(maxActivations) || maxActivations < 1) {
    setAdminStatus(adminPromoStatus, "Укажи количество активаций (минимум 1)", "error");
    return;
  }

  adminPromoCreateBtn.disabled = true;
  try {
    await adminPost("/admin/promo/create", {
      code,
      discount_percent: discountPercent,
      max_activations: maxActivations,
    });
    adminPromoCode.value = "";
    adminPromoDiscount.value = "";
    adminPromoActivations.value = "";
    setAdminStatus(adminPromoStatus, "Промокод создан", "success");
    tg?.HapticFeedback?.notificationOccurred("success");
    loadAdminPromos();
  } catch (err) {
    setAdminStatus(adminPromoStatus, "Не удалось создать: " + err.message, "error");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    adminPromoCreateBtn.disabled = false;
  }
});

// --- Промокоды конкретного пользователя (поиск по username/id, любые) ---

// Запоминаем, чьи промокоды сейчас показаны в списке, — нужно только
// чтобы после удаления кода перезапросить список того же пользователя,
// а не заставлять админа вводить его снова.
let currentUserPromoTarget = "";

function renderUserPromoList(items) {
  adminUserPromoList.innerHTML = "";
  adminUserPromoEmpty.hidden = items.length > 0;

  items.forEach((promo) => {
    const row = document.createElement("div");
    row.className = "admin-list-item";

    const info = document.createElement("div");
    info.className = "admin-list-item-info";

    const title = document.createElement("div");
    title.className = "admin-list-item-title";
    title.textContent = promo.code;

    const sub = document.createElement("div");
    sub.className = "admin-list-item-sub";
    sub.textContent = promo.used ? "Уже использован" : "Не использован";

    info.appendChild(title);
    info.appendChild(sub);

    const badge = document.createElement("span");
    badge.className = "admin-list-item-badge";
    badge.textContent = `-${promo.discount_percent}%`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "admin-list-item-remove";
    removeBtn.innerHTML = REMOVE_ICON_SVG;
    removeBtn.addEventListener("click", () => deleteUserPromo(promo.code));

    row.appendChild(info);
    row.appendChild(badge);
    row.appendChild(removeBtn);
    adminUserPromoList.appendChild(row);
  });
}

async function searchUserPromoCodes(target) {
  adminUserPromoBtn.disabled = true;
  try {
    const data = await adminPost("/admin/user_promo_codes", { target });
    currentUserPromoTarget = target;
    const who = data.username ? "@" + data.username : `id ${data.user_id}`;
    if (data.codes.length === 0) {
      setAdminStatus(adminUserPromoStatus, `У пользователя ${who} пока нет промокодов`, "success");
    } else {
      setAdminStatus(adminUserPromoStatus, `Промокоды пользователя ${who}:`, "success");
    }
    renderUserPromoList(data.codes || []);
  } catch (err) {
    currentUserPromoTarget = "";
    const message = err.message === "user_not_found"
      ? "Этот пользователь ни разу не открывал мини-апп — его нельзя найти по username"
      : "Не удалось найти пользователя: " + err.message;
    setAdminStatus(adminUserPromoStatus, message, "error");
    renderUserPromoList([]);
  } finally {
    adminUserPromoBtn.disabled = false;
  }
}

async function deleteUserPromo(code) {
  try {
    await adminPost("/admin/user_promo_delete", { code });
    tg?.HapticFeedback?.selectionChanged();
    if (currentUserPromoTarget) searchUserPromoCodes(currentUserPromoTarget);
  } catch (err) {
    setAdminStatus(adminUserPromoStatus, "Не удалось удалить промокод", "error");
  }
}

adminUserPromoBtn.addEventListener("click", () => {
  const target = adminUserPromoInput.value.trim();
  if (!target) {
    setAdminStatus(adminUserPromoStatus, "Введи username или id пользователя", "error");
    return;
  }
  searchUserPromoCodes(target);
});

// ====== Инициализация ======
// Рендерим карточки и профиль только когда сплэш реально скрывается —
// так плавное появление карточек видно пользователю, а не "съедается"
// временем, пока крутится экран загрузки.
let appInitialized = false;

function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  renderProducts();
  fillProfileFromTelegram();
  // Экран "Магазин" изначально активен прямо в HTML (без вызова
  // switchView), поэтому ему тоже нужно явно навесить класс анимации
  // появления — иначе он останется без неё при самом первом запуске.
  switchView("shop");
}
