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
    price: 2,
    initial: "D",
    badges: ["UNDETECTED"],
  },
];

// Сроки доступа — должны совпадать с DURATIONS в bot.py.
// Цены указаны в звёздах (Telegram Stars) — поменяй значения price
// на свои под каждый тариф.
const DURATIONS = [
  { code: "7d", label: "7 дней", price: 2 },
  { code: "30d", label: "30 дней", price: 2 },
  { code: "12m", label: "12 месяцев", price: 2 },
];

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

// ====== Сплэш / плавное появление ======
const splash = document.getElementById("splash");
const app = document.getElementById("app");

let splashDone = false;

function hideSplash() {
  if (splashDone) return;
  splashDone = true;
  splash.classList.add("splash--hidden");
  app.classList.add("app--ready");
  initApp();
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

// ====== Способ оплаты (Telegram Stars / NFT / Русская карта) ======
const paymentSelect = document.getElementById("paymentSelect");
const paymentToggle = document.getElementById("paymentToggle");
const paymentToggleIcon = document.getElementById("paymentToggleIcon");
const paymentToggleLabel = document.getElementById("paymentToggleLabel");
const paymentOptions = document.getElementById("paymentOptions");
const checkoutManualBtn = document.getElementById("checkoutManualBtn");
const nftModal = document.getElementById("nftModal");
const nftModalBackdrop = document.getElementById("nftModalBackdrop");
const nftModalTitle = document.getElementById("nftModalTitle");
const nftModalText = document.getElementById("nftModalText");
const nftModalCancel = document.getElementById("nftModalCancel");
const nftModalWrite = document.getElementById("nftModalWrite");

// Telegram-логин владельца, которому пишет пользователь при оплате
// способами, оформляемыми вручную (NFT, Русская карта).
const MANUAL_PAYMENT_OWNER_USERNAME = "meaninglessperson";

// Способы оплаты, которые оформляются не автоматически, а перепиской с
// владельцем в личных сообщениях. Чтобы добавить новый такой способ,
// достаточно добавить сюда запись и кнопку .payment-option с тем же
// data-method в разметке.
const MANUAL_PAYMENT_METHODS = {
  nft: {
    buyLabel: "Нажмите для оплаты NFT",
    modalTitle: "Оплата NFT",
    modalText: "Напишите владельцу, чтобы оформить оплату NFT",
  },
  card: {
    buyLabel: "Нажмите для оплаты картой",
    modalTitle: "Оплата картой",
    modalText: "Напишите владельцу, чтобы оформить оплату Русской картой",
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
    btn.classList.toggle("payment-option--selected", btn.dataset.method === method);
  });
  updatePaymentToggleSummary(method);

  const manualConfig = MANUAL_PAYMENT_METHODS[method];
  if (manualConfig) {
    checkoutBuyBtn.hidden = true;
    checkoutManualBtn.hidden = false;
    checkoutManualBtn.textContent = manualConfig.buyLabel;
  } else {
    checkoutManualBtn.hidden = true;
    checkoutBuyBtn.hidden = false;
  }
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

  [nftModalBackdrop, nftModal.querySelector(".nft-modal-card")].forEach((el) => {
    if (!el) return;
    el.style.animation = "none";
    void el.offsetHeight;
    el.style.animation = "";
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
  // Открываем личные сообщения с владельцем в Telegram. tg.openTelegramLink
  // корректно работает внутри Mini App, window.open — запасной вариант
  // для случаев, когда приложение открыто вне Telegram.
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/${MANUAL_PAYMENT_OWNER_USERNAME}`);
  } else {
    window.open(`https://t.me/${MANUAL_PAYMENT_OWNER_USERNAME}`, "_blank");
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
  viewCheckout.querySelector(".description-card"),
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
  void viewCheckout.offsetHeight; // форсируем reflow перед повторным добавлением класса

  checkoutAnimatedEls.forEach((el, index) => {
    el.style.animationDelay = `${index * 70 + 60}ms`;
    el.classList.add("co-anim-in");
  });

  clearTimeout(checkoutAnimSafetyTimer);
  checkoutAnimSafetyTimer = setTimeout(() => {
    checkoutAnimatedEls.forEach((el) => el.classList.remove("co-anim-in"));
  }, 900);
}

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
  case: document.getElementById("view-case"),
  mypromos: document.getElementById("view-mypromos"),
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

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchView(tab.dataset.view);
    tg?.HapticFeedback?.selectionChanged();
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
const CASE_REEL_VALUES = [5, 10, 15, 30, 50];
const CASE_REEL_DECOYS_BEFORE = 28;
const CASE_REEL_DECOYS_AFTER = 6;
const CASE_SPIN_DURATION_MS = 3200;

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
  caseOpenBtn.textContent = "Открыть кейс";
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
    void el.offsetHeight;
    el.style.animation = "";
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
  if (discountPercent === 5 || discountPercent === 10) {
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

async function openCase() {
  caseOpenBtn.disabled = true;
  caseOpenBtn.hidden = true;
  caseResult.hidden = true;
  caseAgainBtn.hidden = true;
  setCaseStatus("");
  caseStage.classList.add("case-stage--spinning");
  caseReelWrap.hidden = false;

  try {
    const response = await fetch("/open_case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg ? tg.initData : "" }),
    });
    if (!response.ok) throw new Error("Сервер не смог открыть кейс");
    const data = await response.json();

    spinReelTo(data.discount_percent);
    tg?.HapticFeedback?.selectionChanged();

    // Ждём, пока рулетка реально докрутится до приза, и только потом
    // показываем карточку результата — иначе она появится раньше, чем
    // прокрутка остановится, и будет выглядеть рассинхронизированно.
    await new Promise((resolve) => setTimeout(resolve, CASE_SPIN_DURATION_MS));

    caseResultBadge.textContent = `-${data.discount_percent}%`;
    caseResultBadge.className = "case-result-badge " + rarityClassFor(data.discount_percent);
    caseResultCode.textContent = data.code;

    caseCopyBtn.textContent = "Скопировать";
    caseCopyBtn.classList.remove("case-copy-btn--copied");

    caseResult.hidden = false;
    caseResult.style.animation = "none";
    caseResult.offsetHeight; // reflow, чтобы анимация точно применилась заново
    caseResult.style.animation = "";
    caseAgainBtn.hidden = false;

    caseReelWrap.hidden = true;
    caseStage.classList.remove("case-stage--spinning");
    caseStage.classList.add("case-stage--opened");

    setCaseStatus("Промокод действует на одну покупку — вставь его на экране оформления", "success");
    tg?.HapticFeedback?.notificationOccurred("success");

    // Мини-меню с промокодом поверх экрана — появляется сразу после того,
    // как кнопка "Открыть кейс ещё раз" уже видна.
    showCasePrizeModal(data.discount_percent, data.code);
  } catch (err) {
    caseReelWrap.hidden = true;
    caseStage.classList.remove("case-stage--spinning");
    caseOpenBtn.hidden = false;
    setCaseStatus(err.message || "Не удалось открыть кейс, попробуй ещё раз", "error");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    caseOpenBtn.disabled = false;
    caseOpenBtn.textContent = "Открыть кейс";
  }
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
