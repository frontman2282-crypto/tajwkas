// ====== Каталог товаров ======
// Чтобы добавить новый товар — просто добавь объект в этот массив.
// id должен совпадать с ключом PRODUCTS в bot.py.
const PRODUCTS = [
  {
    id: "dystopia",
    title: "Dystopia",
    subtitle: "Доступ к закрытой коллекции",
    price: 1,
    initial: "D",
    badges: ["UNDETECTED"],
  },
];

// Сроки доступа — должны совпадать с DURATIONS в bot.py
const DURATIONS = [
  { code: "1w", label: "1 неделя", price: 1 },
  { code: "1m", label: "1 месяц", price: 1 },
  { code: "1y", label: "1 год", price: 1 },
];

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

function updateBuyButtonLabel(buyBtnText, product, durationCode) {
  const duration = DURATIONS.find((d) => d.code === durationCode) || DURATIONS[0];
  buyBtnText.innerHTML = `Купить за ${duration.price} ${STAR_ICON_SVG}`;
}

function setCardStatus(statusEl, text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "card-status" + (type ? " " + type : "");
}

async function getInvoiceLink(productId, durationCode) {
  const initData = tg ? tg.initData : "";

  const response = await fetch("/create_invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      duration: durationCode,
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

  return data.invoice_link;
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
    const invoiceLink = await getInvoiceLink(product.id, durationCode);

    tg.openInvoice(invoiceLink, (status) => {
      buyBtn.disabled = false;
      updateBuyButtonLabel(buyBtnText, product, durationCode);

      if (status === "paid") {
        setCardStatus(statusEl, `Оплата прошла! Доступ на ${duration.label} выдан.`, "success");
        tg.HapticFeedback?.notificationOccurred("success");
        refreshProfile();
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
const checkoutBadges = document.getElementById("checkoutBadges");
const checkoutDurations = document.getElementById("checkoutDurations");
const checkoutBuyBtn = document.getElementById("checkoutBuyBtn");
const checkoutBuyText = document.getElementById("checkoutBuyText");
const checkoutStatus = document.getElementById("checkoutStatus");
const checkoutBack = document.getElementById("checkoutBack");

let checkoutProduct = null;
let checkoutDuration = DURATIONS[0].code;

function openCheckout(product) {
  checkoutProduct = product;
  checkoutDuration = DURATIONS[0].code;

  checkoutTitle.textContent = product.title;
  checkoutInitial.textContent = product.initial;
  checkoutSubtitle.textContent = product.subtitle;

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

  if (target === "profile") {
    refreshProfile();
  }
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
const profilePurchases = document.getElementById("profilePurchases");

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

async function refreshProfile() {
  const user = tg?.initDataUnsafe?.user;
  if (!user) return;

  try {
    const response = await fetch(`/profile?user_id=${user.id}`);
    if (!response.ok) return;
    const data = await response.json();
    profilePurchases.textContent = data.purchases ?? 0;
  } catch (err) {
    // тихо игнорируем — счётчик просто останется как был
  }
}

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
  refreshProfile();
}
