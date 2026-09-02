function getSavedAuth() {
  const token = localStorage.getItem("sklad_session");
  return token ? `Bearer ${token}` : null;
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
    const res = await fetch(`${CONFIG.PROXY_URL}/login`, { method: "POST", headers: { Authorization: authHeader } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = data.error || "Не удалось войти"; return; }
    localStorage.setItem("sklad_session", data.token);
    localStorage.setItem("sklad_user", login);
    enterScanScreen();
  } catch {
    errEl.textContent = "Нет соединения с сервером";
  }
}

function logout() {
  localStorage.removeItem("sklad_session");
  localStorage.removeItem("sklad_user");
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
  document.getElementById("result-body").innerHTML = `<div class="card ok"><div class="badge ok">ПРОВЕРЕНО ✓</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><p class="meta">Отгрузка есть в маршруте и отмечена. Статус в МойСклад пока не менялся.</p></div><div id="photo-block" class="card"><p class="hint">Загружаю фото…</p></div>`;
  loadPhoto(data.name);
}
async function openOrderDetail(number) {
  const listEl = document.getElementById("modal-list");
  const titleEl = document.getElementById("modal-title");
  if (titleEl) titleEl.textContent = `Заказ № ${number}`;
  listEl.innerHTML = '<div class="spinner"></div><p class="hint">Загружаю…</p>';

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(number)}&_=${Date.now()}`, {
      headers: { Authorization: getSavedAuth() },
      cache: "no-store",
    });
    const data = await res.json();

    if (!data.found) {
      listEl.innerHTML = `<p class="error">Заказ № ${escapeHtml(number)} не найден.</p>
        <button class="link-btn" onclick="renderModalList(); document.getElementById('modal-title').textContent='Список маршрута';">← Назад к списку</button>`;
      return;
    }

    listEl.innerHTML = `
      <div class="card">
        <div class="num">№ ${escapeHtml(data.name)}</div>
        <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
        <div class="meta">Статус: <b>${escapeHtml(data.stateName || "—")}</b></div>
        <div class="meta">Позиций: <b>${escapeHtml(String(data.positionsCount))}</b></div>
        <div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div>
      </div>
      <button class="btn-secondary" onclick="loadPhotoInto('photo-slot-${escapeHtml(data.name)}', '${escapeHtml(data.name)}')">Фото</button>
      <div id="photo-slot-${escapeHtml(data.name)}"></div>
      <button class="link-btn" onclick="renderModalList(); document.getElementById('modal-title').textContent='Список маршрута';">← Назад к списку</button>
    `;
  } catch (e) {
    listEl.innerHTML = '<p class="error">Не удалось загрузить данные заказа.</p>';
  }
}

async function loadPhotoInto(elId, number) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '<p class="hint">Загружаю фото…</p>';
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/photo?number=${encodeURIComponent(number)}&_=${Date.now()}`, {
      headers: { Authorization: getSavedAuth() },
      cache: "no-store",
    });
    const data = await res.json();
    if (data.found && data.url) {
      el.innerHTML = `<img src="${data.url}" alt="Фото заказа" style="width:100%; border-radius:10px; margin-top:8px;" onclick="window.open('${data.url}','_blank')">`;
    } else {
      el.innerHTML = renderPhotoDebug(data);
    }
  } catch (e) {
    el.innerHTML = '<p class="hint">Не удалось загрузить фото</p>';
  }
}
function renderReady(data) {
  document.getElementById("result-body").innerHTML = `<div class="card ok"><div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div><div class="num">№ ${escapeHtml(data.name)}</div><div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div><div class="meta">Количество мест: <b>${escapeHtml(data.places == null ? "—" : String(data.places))}</b></div><div class="meta">Позиций в заказе: <b>${escapeHtml(String(data.positionsCount))}</b></div><div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div><p class="meta">Это индивидуальная отгрузка. После подтверждения статус изменится в МойСклад.</p></div><div id="photo-block" class="card"><p class="hint">Загружаю фото…</p></div><button class="btn-success" onclick="confirmShip()">Подтвердить отгрузку</button>`;
  loadPhoto(data.name);
}

function renderPhotoDebug(data) {
  let html = '<p class="hint">Фото не найдено в Bitrix24</p>';
  if (data.error) {
    html += `<p class="hint" style="color:#fca5a5;">Ошибка: ${escapeHtml(data.error)}</p>`;
  }
  // Показываем ВСЁ, что прислал сервер, кроме уже показанных found/error —
  // формат отладки в worker.js может меняться, тут не гадаем про поля.
  const rest = Object.assign({}, data);
  delete rest.found;
  delete rest.error;
  delete rest.url;
  if (Object.keys(rest).length) {
    html += `<pre style="font-size:11px; color:#9ca3af; text-align:left; white-space:pre-wrap; word-break:break-all; margin-top:8px; max-height:300px; overflow:auto;">${escapeHtml(JSON.stringify(rest, null, 2))}</pre>`;
  }
  return html;
}

async function loadPhoto(number) {
  const el = document.getElementById("photo-block");
  if (!el) return;
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/photo?number=${encodeURIComponent(number)}&_=${Date.now()}`, {
      headers: { Authorization: getSavedAuth() },
      cache: "no-store",
    });
    const data = await res.json();
    if (!el.isConnected) return; // экран уже сменился, пока грузилось фото
    if (data.found && data.url) {
      el.innerHTML = `<img src="${data.url}" alt="Фото заказа" style="width:100%; border-radius:10px; display:block;" onclick="window.open('${data.url}','_blank')">`;
    } else {
      el.innerHTML = renderPhotoDebug(data);
    }
  } catch (e) {
    if (el.isConnected) el.innerHTML = '<p class="hint">Не удалось загрузить фото</p>';
  }
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
//ebony
