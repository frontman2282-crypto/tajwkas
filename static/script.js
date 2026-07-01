// ====== Каталог товаров ======
// Чтобы добавить новый товар — просто добавь объект в этот массив.
// id должен совпадать с ключом PRODUCTS в bot.py.
const PRODUCTS = [
  {
    id: "dystopia",
    title: "Dystopia",
    subtitle: "Цифровой доступ к закрытой коллекции",
    price: 150,
    initial: "D",
    badges: ["UNDETECTED"],
  },
];

// ====== Инициализация Telegram WebApp ======
const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#050208");
  tg.setBackgroundColor("#050208");
}

// ====== Сплэш / плавное появление ======
window.addEventListener("load", () => {
  const splash = document.getElementById("splash");
  const app = document.getElementById("app");

  setTimeout(() => {
    splash.classList.add("splash--hidden");
    app.classList.add("app--ready");
  }, 550);
});

// ====== Рендер карточек товаров ======
const productList = document.getElementById("productList");
const cardTemplate = document.getElementById("productCardTemplate");

function renderProducts() {
  productList.innerHTML = "";

  PRODUCTS.forEach((product) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector(".card");

    card.dataset.productId = product.id;

    const badgesEl = node.querySelector(".card-badges");
    (product.badges || []).forEach((badgeText) => {
      const b = document.createElement("span");
      b.className = "badge-tag";
      b.textContent = badgeText;
      badgesEl.appendChild(b);
    });

    node.querySelector(".art-core").textContent = product.initial;
    node.querySelector(".card-title").textContent = product.title;
    node.querySelector(".card-subtitle").textContent = product.subtitle;
    node.querySelector(".price-value").textContent = product.price;

    const buyBtn = node.querySelector(".buy-btn");
    const buyBtnText = node.querySelector(".buy-btn-text");
    const statusEl = node.querySelector(".card-status");

    buyBtnText.textContent = `Купить за ${product.price} ★`;

    buyBtn.addEventListener("click", () => handleBuy(product, buyBtn, buyBtnText, statusEl));

    productList.appendChild(node);
  });
}

function setCardStatus(statusEl, text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "card-status" + (type ? " " + type : "");
}

async function getInvoiceLink(productId) {
  const initData = tg ? tg.initData : "";

  const response = await fetch("/create_invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
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

async function handleBuy(product, buyBtn, buyBtnText, statusEl) {
  if (!tg) {
    setCardStatus(statusEl, "Открой это приложение внутри Telegram", "error");
    return;
  }

  buyBtn.disabled = true;
  buyBtnText.textContent = "Открываем оплату...";
  setCardStatus(statusEl, "");

  try {
    const invoiceLink = await getInvoiceLink(product.id);

    tg.openInvoice(invoiceLink, (status) => {
      buyBtn.disabled = false;
      buyBtnText.textContent = `Купить за ${product.price} ★`;

      if (status === "paid") {
        setCardStatus(statusEl, "Оплата прошла успешно! Товар выдан.", "success");
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
    buyBtnText.textContent = `Купить за ${product.price} ★`;
    setCardStatus(statusEl, err.message || "Ошибка при создании оплаты", "error");
  }
}

// ====== Вкладки ======
const tabs = document.querySelectorAll(".tab");
const views = {
  shop: document.getElementById("view-shop"),
  profile: document.getElementById("view-profile"),
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.view;

    tabs.forEach((t) => t.classList.remove("tab--active"));
    tab.classList.add("tab--active");

    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("view--active", key === target);
    });

    tg?.HapticFeedback?.selectionChanged();

    if (target === "profile") {
      refreshProfile();
    }
  });
});

// ====== Профиль ======
const profileAvatar = document.getElementById("profileAvatar");
const profileAvatarFallback = document.getElementById("profileAvatarFallback");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");
const profilePurchases = document.getElementById("profilePurchases");

function fillProfileFromTelegram() {
  const user = tg?.initDataUnsafe?.user;

  if (!user) {
    profileName.textContent = "Гость";
    profileUsername.textContent = "Открой из Telegram";
    return;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  profileName.textContent = fullName || "Без имени";
  profileUsername.textContent = user.username ? "@" + user.username : "Без ника";

  if (user.photo_url) {
    profileAvatar.src = user.photo_url;
    profileAvatar.hidden = false;
    profileAvatarFallback.hidden = true;
  } else {
    profileAvatarFallback.textContent = (user.first_name || "?").charAt(0).toUpperCase();
    profileAvatarFallback.hidden = false;
    profileAvatar.hidden = true;
  }
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
renderProducts();
fillProfileFromTelegram();
refreshProfile();
