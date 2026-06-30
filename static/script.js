// ====== Настройки ======
const PRODUCT_ID = "dystopia";

// ====== Инициализация Telegram WebApp ======
const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#120a22");
  tg.setBackgroundColor("#0a0613");
}

const buyBtn = document.getElementById("buyBtn");
const buyBtnText = document.getElementById("buyBtnText");
const statusEl = document.getElementById("status");

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? " " + type : "");
}

function setLoading(isLoading) {
  buyBtn.disabled = isLoading;
  buyBtnText.textContent = isLoading ? "Открываем оплату..." : "Купить за 150 ★";
}

async function getInvoiceLink() {
  const initData = tg ? tg.initData : "";

  // Фронтенд и бэкенд теперь на одном домене -> относительный путь,
  // никакой отдельной ссылки указывать не нужно.
  const response = await fetch("/create_invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: PRODUCT_ID,
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

buyBtn.addEventListener("click", async () => {
  if (!tg) {
    setStatus("Открой это приложение внутри Telegram", "error");
    return;
  }

  setLoading(true);
  setStatus("");

  try {
    const invoiceLink = await getInvoiceLink();

    tg.openInvoice(invoiceLink, (status) => {
      setLoading(false);

      if (status === "paid") {
        setStatus("Оплата прошла успешно! Товар выдан.", "success");
        tg.HapticFeedback?.notificationOccurred("success");
      } else if (status === "cancelled") {
        setStatus("Оплата отменена");
      } else if (status === "failed") {
        setStatus("Оплата не прошла", "error");
      } else {
        setStatus("Статус: " + status);
      }
    });
  } catch (err) {
    setLoading(false);
    setStatus(err.message || "Ошибка при создании оплаты", "error");
  }
});
