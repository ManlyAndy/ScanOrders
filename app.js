// ===========================================================
// Логика приложения. Настройки — в config.js
// ===========================================================

let html5QrCode = null;
let currentResult = null;
let currentRoute = null; // { date, type, numbers: [...], scanned: Set, scannedItems: {}, closedAt, finalization }
let selectedRouteType = "МСК";

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function routeStorageKey(type) {
  return "sklad_route_" + todayStr() + "_" + (type || selectedRouteType);
}

function cleanupOldRouteStorage() {
  const prefix = "sklad_route_";
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const match = key.match(/^sklad_route_(\d{4}-\d{2}-\d{2})_(МСК|ТК)$/);
    if (!match) continue;
    const [y, m, d] = match[1].split("-").map(Number);
    const routeDate = new Date(y, m - 1, d);
    if (routeDate < cutoff) localStorage.removeItem(key);
  }
}

function selectRouteType(type) {
  selectedRouteType = type;
  document.getElementById("type-btn-МСК").classList.toggle("active", type === "МСК");
  document.getElementById("type-btn-ТК").classList.toggle("active", type === "ТК");
  currentRoute = loadRouteFromStorage();
  renderRouteStatus();
}

function loadRouteFromStorage() {
  const raw = localStorage.getItem(routeStorageKey());
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return {
      date: data.date,
      type: data.type,
      numbers: Array.isArray(data.numbers) ? data.numbers : [],
      scanned: new Set(data.scanned || []),
      scannedItems: data.scannedItems || {},
      closedAt: data.closedAt || null,
      finalization: data.finalization || null,
    };
  } catch (e) {
    return null;
  }
}

function saveRouteToStorage() {
  if (!currentRoute) return;
  localStorage.setItem(
    routeStorageKey(currentRoute.type),
    JSON.stringify({
      date: currentRoute.date,
      type: currentRoute.type,
      numbers: currentRoute.numbers,
      scanned: Array.from(currentRoute.scanned),
      scannedItems: currentRoute.scannedItems || {},
      closedAt: currentRoute.closedAt || null,
      finalization: currentRoute.finalization || null,
    })
  );
}

function renderRouteStatus() {
  const el = document.getElementById("route-status");
  const clearBtn = document.getElementById("clear-route-btn");
  const listBtn = document.getElementById("show-list-btn");
  const closeBtn = document.getElementById("close-route-btn");
  if (!currentRoute) {
    el.textContent = `Маршрут "${selectedRouteType}" не загружен — индивидуальное сканирование`;
    clearBtn.style.display = "none";
    listBtn.style.display = "none";
    closeBtn.style.display = "none";
    return;
  }

  const scanned = currentRoute.scanned.size;
  const total = currentRoute.numbers.length;
  const missing = total - scanned;
  if (currentRoute.closedAt) {
    el.textContent = `Маршрут "${currentRoute.type}" закрыт: отгружено ${scanned} из ${total}`;
    closeBtn.style.display = "none";
  } else {
    el.textContent = `Маршрут "${currentRoute.type}" на ${currentRoute.date}: просканировано ${scanned} из ${total}`;
    closeBtn.style.display = "block";
  }
  if (missing > 0 && currentRoute.closedAt) {
    el.textContent += ` · не найдены: ${missing}`;
  }
  clearBtn.style.display = "inline-block";
  listBtn.style.display = "block";
  renderModalList();
}

function openRouteModal() {
  if (!currentRoute) return;
  document.getElementById("modal-title").textContent =
    `Маршрут "${currentRoute.type}" — ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
  renderModalList();
  document.getElementById("route-modal").classList.add("active");
}

function closeRouteModal() {
  document.getElementById("route-modal").classList.remove("active");
}

function renderModalList() {
  if (!currentRoute) return;
  const listEl = document.getElementById("modal-list");
  const sorted = [...currentRoute.numbers].sort((a, b) => {
    const aScanned = currentRoute.scanned.has(a);
    const bScanned = currentRoute.scanned.has(b);
    if (aScanned === bScanned) return a.localeCompare(b, undefined, { numeric: true });
    return aScanned ? 1 : -1;
  });
  listEl.innerHTML = sorted
    .map((num) => {
      const scanned = currentRoute.scanned.has(num);
      const info = currentRoute.scannedItems && currentRoute.scannedItems[num];
      let mark = "";
      if (scanned) mark = "✓";
      else if (currentRoute.closedAt && info && info.error) mark = "⚠";
      const errorLine = !scanned && currentRoute.closedAt && info && info.error
        ? `<div class="error-detail">${escapeHtml(info.error)}</div>`
        : "";
      return `<div class="modal-row ${scanned ? "scanned" : ""} ${!scanned && currentRoute.closedAt ? "problem" : ""}">
        <div>
          <span>№ ${escapeHtml(num)}</span>
          ${errorLine}
        </div>
        <span class="check">${mark}</span>
      </div>`;
    })
    .join("");
  const titleEl = document.getElementById("modal-title");
  if (titleEl) titleEl.textContent = `Маршрут "${currentRoute.type}" — ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
}

async function loadRoute() {
  const el = document.getElementById("route-status");
  el.textContent = "Загружаю маршрут…";
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${todayStr()}&_=${Date.now()}`, {
      headers: { Authorization: getSavedAuth() },
      cache: "no-store",
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.found) {
      el.textContent = "Логист ещё не загрузил маршрут на сегодня";
      return;
    }

    const filteredNumbers = (data.items || [])
      .filter((it) => it.label === selectedRouteType)
      .map((it) => it.number);

    if (!filteredNumbers.length) {
      el.textContent = `На сегодня нет загруженного маршрута типа "${selectedRouteType}"`;
      return;
    }

    // Не стираем локальный прогресс, если пользователь просто обновил тот же маршрут.
    const stored = loadRouteFromStorage();
    const sameNumbers = stored && stored.numbers.length === filteredNumbers.length &&
      stored.numbers.every((n) => filteredNumbers.includes(n));

    currentRoute = sameNumbers
      ? { ...stored, date: data.date, type: selectedRouteType, numbers: filteredNumbers }
      : { date: data.date, type: selectedRouteType, numbers: filteredNumbers, scanned: new Set(), scannedItems: {}, closedAt: null, finalization: null };

    saveRouteToStorage();
    renderRouteStatus();
  } catch (e) {
    el.textContent = "Не удалось загрузить маршрут — проверьте интернет";
  }
}

function clearRoute() {
  if (!currentRoute) return;
  const ok = confirm(
    `Сбросить список "${currentRoute.type}" на этом телефоне?\n\n` +
    `Это НЕ меняет статусы в МойСклад — только очищает сохранённый маршрут на устройстве.`
  );
  if (!ok) return;
  localStorage.removeItem(routeStorageKey(currentRoute.type));
  currentRoute = null;
  renderRouteStatus();
}

async function closeRoute() {
  if (!currentRoute || currentRoute.closedAt) return;
  if (!currentRoute.scanned.size) {
    alert("Нельзя закрыть маршрут: ни одной отгрузки не просканировано.");
    return;
  }

  const total = currentRoute.numbers.length;
  const scanned = currentRoute.scanned.size;
  const missing = total - scanned;
  const message = missing
    ? `В маршруте ${total} отгрузок, просканировано ${scanned}.\n\n` +
      `Не найдены: ${missing}.\n\n` +
      `Закрыть маршрут и изменить статус у всех ${scanned} просканированных отгрузок?`
    : `Все ${total} отгрузок просканированы.\n\nЗакрыть маршрут и изменить их статус?`;

  if (!confirm(message)) return;

  const body = document.getElementById("route-status");
  body.textContent = "Закрываю маршрут и меняю статусы…";

  const items = Array.from(currentRoute.scanned)
    .map((number) => currentRoute.scannedItems[number])
    .filter((item) => item && item.id)
    .map((item) => ({ id: item.id, name: item.name || "" }));

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/finish`, {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    currentRoute.closedAt = new Date().toISOString();
    currentRoute.finalization = data;

    for (const item of data.results || []) {
      const key = item.name || item.id;
      if (!key) continue;
      if (item.ok || item.alreadyShipped) {
        currentRoute.scanned.add(key);
        currentRoute.scannedItems[key] = { id: item.id, name: key, shipped: true };
      } else {
        // Отметка сканирования остаётся только за реально отгруженными позициями.
        // Проблемную позицию можно потом обработать отдельно вручную.
        currentRoute.scanned.delete(key);
        currentRoute.scannedItems[key] = { id: item.id, name: key, error: item.error || "Не удалось изменить статус" };
      }
    }
    saveRouteToStorage();
    renderRouteStatus();
    renderModalList();
    openRouteModal();

    const successCount = (data.results || []).filter((x) => x.ok || x.alreadyShipped).length;
    const failedCount = (data.results || []).filter((x) => !x.ok && !x.alreadyShipped).length;
    alert(
      `Маршрут закрыт.\n\n` +
      `Успешно: ${successCount}\n` +
      `Ошибок при смене статуса: ${failedCount}\n` +
      `Не просканировано: ${total - currentRoute.scanned.size}`
    );
  } catch (e) {
    body.textContent = "Не удалось закрыть маршрут — проверьте интернет. Список сканирования сохранён.";
  }
}

function screens() {
  return {
    login: document.getElementById("screen-login"),
    scan: document.getElementById("screen-scan"),
    result: document.getElementById("screen-result"),
  };
}

function show(name) {
  const s = screens();
  Object.values(s).forEach((el) => el.classList.remove("active"));
  s[name].classList.add("active");
}

// ---------- ВХОД ----------

function getBusinessDayKey(date = new Date()) {
  // Рабочий день начинается в 07:00 по локальному времени телефона.
  // Сессия, полученная после 07:00, действует до следующего 07:00.
  const d = new Date(date);
  if (d.getHours() < 7) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getSavedAuth() {
  const auth = localStorage.getItem("sklad_auth");
  const sessionDay = localStorage.getItem("sklad_auth_day");
  if (!auth || !sessionDay || sessionDay !== getBusinessDayKey()) {
    localStorage.removeItem("sklad_auth");
    localStorage.removeItem("sklad_user");
    localStorage.removeItem("sklad_auth_day");
    return null;
  }
  return auth;
}
function getSavedUser() { return localStorage.getItem("sklad_user") || ""; }

async function doLogin() {
  const login = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!login || !pass) { errEl.textContent = "Заполните логин и пароль"; return; }
  const authHeader = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=__login_check__`, { headers: { Authorization: authHeader } });
    if (res.status === 401) { errEl.textContent = "Неверный логин или пароль"; return; }
    if (!res.ok) { errEl.textContent = "Не удалось связаться с сервером. Проверьте адрес прокси в config.js"; return; }
  } catch (e) { errEl.textContent = "Нет соединения с прокси. Проверьте PROXY_URL в config.js"; return; }
  localStorage.setItem("sklad_auth", authHeader);
  localStorage.setItem("sklad_user", login);
  localStorage.setItem("sklad_auth_day", getBusinessDayKey());
  enterScanScreen();
}

function logout() {
  localStorage.removeItem("sklad_auth");
  localStorage.removeItem("sklad_user");
  localStorage.removeItem("sklad_auth_day");
  stopScanner();
  show("login");
}

function enterScanScreen() {
  document.getElementById("who-label").textContent = getSavedUser();
  document.getElementById("who-label-2").textContent = getSavedUser();
  currentRoute = loadRouteFromStorage();
  renderRouteStatus();
  show("scan");
  setTimeout(startScanner, 300);
}

// ---------- СКАНЕР ----------

function startScanner() {
  const readerEl = document.getElementById("reader");
  readerEl.innerHTML = "";
  html5QrCode = new Html5Qrcode("reader");
  Html5Qrcode.getCameras().then((cameras) => {
    if (!cameras || !cameras.length) { showCameraError(readerEl, "Камера не найдена"); return; }
    const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[0];
    html5QrCode.start(backCam.id, {
      fps: 10,
      qrbox: { width: 250, height: 150 },
      formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
    },
      (decodedText) => onScanSuccess(decodedText), () => {})
      .catch(() => showCameraError(readerEl, "Не удалось запустить камеру. Разрешите доступ к камере в браузере."));
  }).catch(() => showCameraError(readerEl, "Нет доступа к камере"));
}

function showCameraError(readerEl, message) {
  readerEl.innerHTML = `<p class="error">${escapeHtml(message)}</p><button class="btn-secondary" onclick="retryCamera()">Попробовать снова</button>`;
}
function retryCamera() { stopScanner(); setTimeout(startScanner, 300); }
function stopScanner() {
  if (html5QrCode) {
    try { const result = html5QrCode.stop(); if (result && typeof result.catch === "function") result.catch(() => {}); } catch (e) {}
    html5QrCode = null;
  }
}
function onScanSuccess(decodedText) { stopScanner(); lookupCode(decodedText.trim()); }
function showManualInput() { document.getElementById("manual-input-wrap").style.display = "block"; }
function submitManual() {
  const code = document.getElementById("manual-input").value.trim();
  if (!code) return;
  stopScanner();
  lookupCode(code);
}
function backToScan() {
  document.getElementById("manual-input-wrap").style.display = "none";
  document.getElementById("manual-input").value = "";
  show("scan");
  startScanner();
}

// ---------- ПОИСК И ОТОБРАЖЕНИЕ ----------

async function lookupCode(code) {
  show("result");
  const body = document.getElementById("result-body");
  body.innerHTML = '<div class="spinner"></div><p class="hint">Ищу отгрузку ' + escapeHtml(code) + '…</p>';
  const auth = getSavedAuth();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(code)}&_=${Date.now()}`, { headers: { Authorization: auth }, signal: controller.signal, cache: "no-store" });
    clearTimeout(timeoutId);
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!data.found) { renderNotFound(code); return; }
    currentResult = data;

    if (data.alreadyShipped) {
      renderAlreadyShipped(data);
    } else if (!data.ready) {
      renderWrongStatus(data);
    } else if (currentRoute && !currentRoute.closedAt && currentRoute.numbers.includes(data.name)) {
      if (currentRoute.scanned.has(data.name)) renderAlreadyScanned(data);
      else markRouteScanned(data);
    } else if (currentRoute && !currentRoute.closedAt && currentRoute.numbers.length && !currentRoute.numbers.includes(data.name)) {
      renderNotInRoute(data);
    } else {
      // Без активного маршрута, а также после закрытия маршрута — индивидуальное подтверждение.
      renderReady(data);
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") body.innerHTML = '<div class="card bad"><div class="badge bad">ДОЛГИЙ ОТВЕТ</div><p>Сервер МойСклад отвечает дольше 15 секунд. Подождите немного и попробуйте снова.</p></div>';
    else body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Не удалось связаться с сервером. Проверьте интернет.</p></div>';
  }
}

function renderNotFound(code) {
  document.getElementById("result-body").innerHTML = `<div class="card bad"><div class="badge bad">НЕ НАЙДЕНО</div><div class="num">№ ${escapeHtml(code)}</div><p class="meta">Отгрузка с таким номером не найдена. Это может быть чужой или неверный штрихкод.</p></div>`;
}
function renderWrongStatus(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad"><div class="badge bad">НЕ ГОТОВО К ОТГРУЗКЕ</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Текущий статус: <b>${escapeHtml(data.stateName || "—")}</b></div><p class="meta">Этот заказ ещё не в статусе "Собрано" — отгружать его сейчас нельзя.</p></div>`;
}
function renderAlreadyShipped(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad"><div class="badge bad">УЖЕ ОТГРУЖЕНО</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><p class="meta">Этот заказ уже был отсканирован и отгружен ранее.</p></div>`;
}
function renderNotInRoute(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad"><div class="badge bad">НЕ В ЭТОМ МАРШРУТЕ</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><p class="meta">Заказ собран, но его нет в загруженном маршруте "${escapeHtml(currentRoute.type)}". Для отдельной отгрузки подтвердите её без маршрута.</p><button class="btn-success" onclick="confirmShip()">Подтвердить отгрузку</button></div>`;
}
function renderAlreadyScanned(data) {
  document.getElementById("result-body").innerHTML = `<div class="card ok"><div class="badge ok">УЖЕ ПРОСКАНИРОВАНО ✓</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><p class="meta">Отгрузка уже отмечена в текущем маршруте. Статус в МойСклад пока не менялся.</p></div>`;
}
function markRouteScanned(data) {
  currentRoute.scanned.add(data.name);
  currentRoute.scannedItems[data.name] = { id: data.id, name: data.name, places: data.places };
  saveRouteToStorage();
  renderRouteStatus();
  document.getElementById("result-body").innerHTML = `<div class="card ok"><div class="badge ok">ПРОВЕРЕНО ✓</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><p class="meta">Отгрузка есть в маршруте и отмечена. Статус в МойСклад пока не менялся.</p></div>`;
}
function renderReady(data) {
  document.getElementById("result-body").innerHTML = `<div class="card ok"><div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><div class="meta">Позиций в заказе: <b>${escapeHtml(String(data.positionsCount))}</b></div><div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div><p class="meta">Это индивидуальная отгрузка. После подтверждения статус изменится в МойСклад.</p></div><button class="btn-success" onclick="confirmShip()">Подтвердить отгрузку</button>`;
}

async function confirmShip() {
  if (!currentResult) return;
  const body = document.getElementById("result-body");
  body.innerHTML = '<div class="spinner"></div><p class="hint">Меняю статус…</p>';
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/ship`, { method: "POST", headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" }, body: JSON.stringify({ id: currentResult.id }) });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.ok) {
      if (currentRoute && currentRoute.closedAt && currentRoute.numbers.includes(currentResult.name)) {
        currentRoute.scanned.add(currentResult.name);
        currentRoute.scannedItems[currentResult.name] = { id: currentResult.id, name: currentResult.name, places: currentResult.places, shipped: true };
        saveRouteToStorage();
        renderRouteStatus();
      }
      body.innerHTML = `<div class="card ok"><div class="badge ok">ОТГРУЖЕНО ✓</div><div class="num">№ ${escapeHtml(currentResult.name)}</div><p class="meta">Статус успешно изменён в МойСклад.</p></div>`;
    } else {
      body.innerHTML = `<div class="card bad"><div class="badge bad">ОШИБКА</div><p>${escapeHtml(data.error || "Не удалось изменить статус")}</p></div>`;
    }
  } catch (e) { body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Нет соединения с сервером.</p></div>'; }
}

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str == null ? "" : String(str); return d.innerHTML; }

window.addEventListener("load", () => {
  cleanupOldRouteStorage();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (getSavedAuth()) enterScanScreen(); else show("login");
});
