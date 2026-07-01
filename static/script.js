// ====== Каталог товаров ======
// Чтобы добавить новый товар — просто добавь объект в этот массив.
// id должен совпадать с ключом PRODUCTS в bot.py.
const PRODUCTS = [
  {
    id: "dystopia",
    title: "Dystopia",
    subtitle: "Премиальный статус и расширенные возможности",
    description:
      "Dystopia — это премиальный игровой проект нового уровня, созданный для тех, кто хочет больше, чем обычный опыт в игре. Это система уникальных возможностей, расширенного функционала и особого статуса, который выделяет тебя среди остальных игроков.",
    price: 150,
    initial: "D",
    badges: ["UNDETECTED"],
  },
];

// Сроки доступа — должны совпадать с DURATIONS в bot.py.
// Цены указаны в звёздах (Telegram Stars) — поменяй значения price
// на свои под каждый тариф.
const DURATIONS = [
  { code: "7d", label: "7 дней", price: 150 },
  { code: "30d", label: "30 дней", price: 400 },
  { code: "12m", label: "12 месяцев", price: 3000 },
];

// Промокод проверяется и считается всегда на сервере (в bot.py) — это
// касается и статических кодов, и одноразовых кодов из кейса, клиенту в
// этом вопросе не доверяем.

// Иконка звезды (Telegram Stars) — используется вместо символа "★",
// который выглядит по-разному в разных шрифтах/системах
const STAR_ICON_SVG = `<svg class="icon-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.6 7.2.6-5.5 4.7 1.7 7.1-6.3-3.9-6.3 3.9 1.7-7.1-5.5-4.7 7.2-.6z"/></svg>`;

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

// ====== Сплэш / плавное появление ======
const splash = document.getElementById("splash");
const app = document.getElementById("app");
const splashBarFill = document.getElementById("splashBarFill");

let splashProgress = 0;
let splashDone = false;

function setSplashProgress(value) {
  splashProgress = Math.max(splashProgress, Math.min(value, 100));
  if (splashBarFill) splashBarFill.style.width = splashProgress + "%";
}

function hideSplash() {
  if (splashDone) return;
  splashDone = true;
  setSplashProgress(100);
  setTimeout(() => {
    splash.classList.add("splash--hidden");
    app.classList.add("app--ready");
    initApp();
  }, 180);
}

// Плавно "подгружаем" прогресс-бар, пока реально идёт инициализация
setSplashProgress(20);

// Ждём загрузку шрифтов, если поддерживается — экран выглядит аккуратнее,
// когда текст не "прыгает" после появления
const fontsReady = document.fonts && document.fonts.ready
  ? document.fonts.ready.catch(() => {})
  : Promise.resolve();

Promise.race([fontsReady, new Promise((res) => setTimeout(res, 900))]).then(() => {
  setSplashProgress(70);
});

window.addEventListener("load", () => {
  setSplashProgress(90);
});

// Гарантированно скрываем сплэш, даже если что-то пошло не так —
// пользователь никогда не застрянет на экране загрузки
const SPLASH_MIN_TIME = 650;
const SPLASH_MAX_TIME = 2200;
const splashStartedAt = Date.now();

function scheduleHideSplash() {
  const elapsed = Date.now() - splashStartedAt;
  const wait = Math.max(SPLASH_MIN_TIME - elapsed, 0);
  setTimeout(hideSplash, wait);
}

window.addEventListener("load", scheduleHideSplash);
setTimeout(hideSplash, SPLASH_MAX_TIME); // защита от зависания

// ====== Рендер карточек товаров ======
const productList = document.getElementById("productList");
const cardTemplate = document.getElementById("productCardTemplate");
const durationTemplate = document.getElementById("durationOptionTemplate");

function renderProducts() {
  productList.innerHTML = "";

  PRODUCTS.forEach((product, index) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector(".card");
    card.dataset.productId = product.id;
    card.style.setProperty("--card-index", index);

    const row = node.querySelector(".card-row");
    const badgesEl = node.querySelector(".card-row-badges");

    (product.badges || []).forEach((badgeText) => {
      const b = document.createElement("span");
      b.className = "badge-tag";
      b.textContent = badgeText;
      badgesEl.appendChild(b);
    });

    node.querySelector(".card-row-initial").textContent = product.initial;
    node.querySelector(".card-row-title").textContent = product.title;
    node.querySelector(".card-row-subtitle").textContent = product.subtitle;
    node.querySelector(".price-value").textContent = product.price;

    // Клик по карточке — переходим на отдельный экран оформления покупки
    row.addEventListener("click", () => {
      openCheckout(product);
      tg?.HapticFeedback?.selectionChanged();
    });

    productList.appendChild(node);
  });
}

function getFinalPrice(basePrice, discountPercent) {
  if (!discountPercent) return basePrice;
  return Math.max(1, Math.round(basePrice * (1 - discountPercent / 100)));
}

function updateBuyButtonLabel(buyBtnText, product, durationCode) {
  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];
  const finalPrice = getFinalPrice(duration.price, checkoutDiscountPercent);

  if (checkoutDiscountPercent > 0 && finalPrice < duration.price) {
    checkoutOldPrice.textContent = `${duration.price} ★`;
    checkoutOldPrice.hidden = false;
  } else {
    checkoutOldPrice.hidden = true;
  }

  buyBtnText.innerHTML = `Купить за ${finalPrice} ${STAR_ICON_SVG}`;
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

async function handleBuy(product, durationCode, buyBtn, buyBtnText, statusEl) {
  if (!tg) {
    setCardStatus(statusEl, "Открой это приложение внутри Telegram", "error");
    return;
  }

  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];

  buyBtn.disabled = true;
  buyBtnText.textContent = "Открываем оплату...";
  setCardStatus(statusEl, "");

  try {
    const invoiceData = await getInvoiceLink(product.id, durationCode, checkoutPromoCode);
    const invoiceLink = invoiceData.invoice_link;

    // Сервер — источник истины по промокодам. Если он не распознал код,
    // который клиент посчитал валидным, сообщаем об этом честно.
    if (checkoutPromoCode && invoiceData.promo_invalid) {
      setPromoStatus("Промокод не найден, покупка по полной цене", "error");
    }

    tg.openInvoice(invoiceLink, (status) => {
      buyBtn.disabled = false;
      updateBuyButtonLabel(buyBtnText, product, durationCode);

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
    updateBuyButtonLabel(buyBtnText, product, durationCode);
    setCardStatus(statusEl, err.message || "Ошибка при создании оплаты", "error");
  }
}

// ====== Экран оформления покупки (checkout) ======
const viewCheckout = document.getElementById("view-checkout");
const checkoutTitle = document.getElementById("checkoutTitle");
const checkoutInitial = document.getElementById("checkoutInitial");
const checkoutSubtitle = document.getElementById("checkoutSubtitle");
const checkoutDescription = document.getElementById("checkoutDescription");
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

let checkoutProduct = null;
let checkoutDuration = DURATIONS[0].code;
let checkoutPromoCode = null;
let checkoutDiscountPercent = 0;

function openCheckout(product) {
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

  checkoutTitle.textContent = product.title;
  checkoutInitial.textContent = product.initial;
  checkoutSubtitle.textContent = product.subtitle;
  checkoutDescription.textContent = product.description || "";

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
    dNode.querySelector(".duration-option-price").innerHTML = `${duration.price} ${STAR_ICON_SVG}`;
    checkoutDurations.appendChild(dNode);
  });

  checkoutBuyBtn.disabled = false;
  updateBuyButtonLabel(checkoutBuyText, product, checkoutDuration);
  setCardStatus(checkoutStatus, "");

  switchView("checkout");
}

checkoutDurations.addEventListener("click", (e) => {
  const btn = e.target.closest(".duration-option");
  if (!btn || !checkoutProduct) return;

  checkoutDurations.querySelectorAll(".duration-option").forEach((b) => {
    b.classList.toggle("duration-option--selected", b === btn);
  });

  checkoutDuration = btn.dataset.duration;
  updateBuyButtonLabel(checkoutBuyText, checkoutProduct, checkoutDuration);
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
    updateBuyButtonLabel(checkoutBuyText, checkoutProduct, checkoutDuration);
    tg?.HapticFeedback?.notificationOccurred("error");
    return;
  }

  checkoutPromoCode = rawCode;
  checkoutDiscountPercent = data.discount_percent;
  checkoutPromoApply.textContent = "Применено";
  checkoutPromoApply.classList.add("promo-apply-btn--applied");
  checkoutPromoInput.disabled = true;
  setPromoStatus(`Скидка ${data.discount_percent}% применена`, "success");
  updateBuyButtonLabel(checkoutBuyText, checkoutProduct, checkoutDuration);
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
    updateBuyButtonLabel(checkoutBuyText, checkoutProduct, checkoutDuration);
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
};

function switchView(target) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("view--active", key === target);
  });

  // Подсвечиваем вкладку "Магазин", когда открыт экран оформления —
  // это переход внутри магазина, а не отдельный раздел
  const activeTabKey = target === "checkout" ? "shop" : target;
  tabs.forEach((t) => t.classList.toggle("tab--active", t.dataset.view === activeTabKey));

  // Сбрасываем прокрутку контейнера .app в начало при каждом переключении
  // экрана. Раньше этого не было: если пользователь успевал прокрутить
  // страницу вниз, следующий открытый экран (например, чекаут) рендерился
  // корректно, но оказывался вне видимой области — выглядело так, будто
  // "интерфейс не открылся". Это и была причина бага "через раз".
  app.scrollTop = 0;
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchView(tab.dataset.view);
    tg?.HapticFeedback?.selectionChanged();
  });
});

// ====== Профиль ======
const profileAvatar = document.getElementById("profileAvatar");
const profileAvatarFallback = document.getElementById("profileAvatarFallback");
const profileAvatarLetter = document.getElementById("profileAvatarLetter");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");

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

// ====== Кейс с промокодом ======
const caseOpenBtn = document.getElementById("caseOpenBtn");
const caseResult = document.getElementById("caseResult");
const caseResultBadge = document.getElementById("caseResultBadge");
const caseResultCode = document.getElementById("caseResultCode");
const caseCopyBtn = document.getElementById("caseCopyBtn");
const caseStatus = document.getElementById("caseStatus");

function setCaseStatus(text, type = "") {
  caseStatus.textContent = text;
  caseStatus.className = "case-status" + (type ? " " + type : "");
}

// Определяет визуальную "редкость" приза — чисто для оформления карточки
function rarityClassFor(discountPercent) {
  if (discountPercent >= 50) return "case-result-badge--legendary";
  if (discountPercent >= 30) return "case-result-badge--epic";
  if (discountPercent >= 15) return "case-result-badge--rare";
  return "case-result-badge--common";
}

async function openCase() {
  caseOpenBtn.disabled = true;
  caseOpenBtn.textContent = "Открываем...";
  setCaseStatus("");

  try {
    const response = await fetch("/open_case", { method: "POST" });
    if (!response.ok) throw new Error("Сервер не смог открыть кейс");
    const data = await response.json();

    caseResultBadge.textContent = `-${data.discount_percent}%`;
    caseResultBadge.className = "case-result-badge " + rarityClassFor(data.discount_percent);
    caseResultCode.textContent = data.code;

    caseCopyBtn.textContent = "Скопировать";
    caseCopyBtn.classList.remove("case-copy-btn--copied");

    // Перезапускаем анимацию появления, даже если кейс открывают подряд
    caseResult.hidden = false;
    caseResult.style.animation = "none";
    caseResult.offsetHeight; // reflow, чтобы анимация точно применилась заново
    caseResult.style.animation = "";

    setCaseStatus("Промокод действует на одну покупку — вставь его на экране оформления", "success");
    tg?.HapticFeedback?.notificationOccurred("success");
  } catch (err) {
    setCaseStatus(err.message || "Не удалось открыть кейс, попробуй ещё раз", "error");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    caseOpenBtn.disabled = false;
    caseOpenBtn.textContent = "Открыть кейс";
  }
}

caseOpenBtn.addEventListener("click", () => {
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
}
