// ===========================================================
// Логика приложения. Настройки — в config.js
// ===========================================================
let html5QrCode = null;
let currentResult = null;
let currentRoute = null;
let selectedRouteType = "МСК";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function routeStorageKey(type) {
  return "sklad_route_" + todayStr() + "_" + (type || selectedRouteType);
}
function selectRouteType(type) {
  selectedRouteType = type;
  document.getElementById("type-btn-МСК").classList.toggle("active", type === "МСК");
  document.getElementById("type-btn-ТК").classList.toggle("active", type === "ТК");
  const hireBtn = document.getElementById("type-btn-Найм");
  if (hireBtn) hireBtn.classList.toggle("active", type === "Найм");
  currentRoute = loadRouteFromStorage();
  renderRouteStatus();
}
function loadRouteFromStorage() {
  const raw = localStorage.getItem(routeStorageKey());
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { date: data.date, type: data.type, numbers: data.numbers, tasks: data.tasks || [], scanned: new Set(data.scanned || []) };
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
      tasks: currentRoute.tasks || [],
      scanned: Array.from(currentRoute.scanned),
    })
  );
}
function renderRouteStatus() {
  const el = document.getElementById("route-status");
  const clearBtn = document.getElementById("clear-route-btn");
  const listBtn = document.getElementById("show-list-btn");
  if (!currentRoute) {
    el.textContent = `Маршрут "${selectedRouteType}" не загружен — сканирование только по статусу`;
    clearBtn.style.display = "none";
    listBtn.style.display = "none";
    return;
  }
  el.textContent = `Маршрут "${currentRoute.type}" на ${currentRoute.date}: отсканировано ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
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
      return `<div class="modal-row ${scanned ? "scanned" : ""}">
        <span>№ ${escapeHtml(num)}</span>
        <span class="check">${scanned ? "✓" : ""}</span>
      </div>`;
    })
    .join("");
  if (currentRoute.tasks && currentRoute.tasks.length) {
    listEl.innerHTML += `<div style="margin-top:14px;font-weight:700;">Доп. задания</div>` +
      currentRoute.tasks.map(t => `<div class="modal-row"><span>ℹ️ ${escapeHtml(t)}</span></div>`).join("");
  }
}
async function loadRoute() {
  const el = document.getElementById("route-status");
  el.textContent = "Загружаю маршрут…";
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${todayStr()}`, {
      headers: { Authorization: getSavedAuth() },
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
    currentRoute = {
      date: data.date,
      type: selectedRouteType,
      numbers: filteredNumbers,
      tasks: (data.tasksByLabel && data.tasksByLabel[selectedRouteType]) || [],
      scanned: new Set()
    };
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
    `Это НЕ меняет статусы в МойСклад — только очищает список на устройстве.`
  );
  if (!ok) return;
  localStorage.removeItem(routeStorageKey(currentRoute.type));
  currentRoute = null;
  renderRouteStatus();
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
function getSavedAuth() {
  const token = localStorage.getItem("sklad_token");
  return token ? `Bearer ${token}` : null;
}
function getSavedUser() {
  return localStorage.getItem("sklad_user") || "";
}
async function doLogin() {
  const login = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";

  if (!login || !pass) {
    errEl.textContent = "Заполните логин и пароль";
    return;
  }

  const basicAuth = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/login`, {
      method: "POST",
      headers: {
        "Authorization": basicAuth,
        "Content-Type": "application/json"
      },
    });

    if (res.status === 401) {
      errEl.textContent = "Неверный логин или пароль";
      return;
    }
    if (res.status === 403) {
      errEl.textContent = "Доступ к приложению запрещён";
      return;
    }
    if (!res.ok) {
      errEl.textContent = "Не удалось связаться с сервером";
      return;
    }

    const data = await res.json();
    if (!data.ok || !data.token) {
      errEl.textContent = data.error || "Сервер не вернул токен";
      return;
    }

    localStorage.setItem("sklad_token", data.token);
    localStorage.setItem("sklad_user", data.user || login);
    enterScanScreen();
  } catch (e) {
    errEl.textContent = "Нет соединения с прокси. Проверьте PROXY_URL в config.js";
  }
}
function logout() {
  localStorage.removeItem("sklad_token");
  localStorage.removeItem("sklad_user");
  stopScanner();
  show("login");
}
function enterScanScreen() {
  document.getElementById("who-label").textContent = getSavedUser();
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
  Html5Qrcode.getCameras()
    .then((cameras) => {
      if (!cameras || !cameras.length) {
        showCameraError(readerEl, "Камера не найдена");
        return;
      }
      const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[0];
      html5QrCode
        .start(
          backCam.id,
          { fps: 10, qrbox: { width: 220, height: 120 } },
          (decodedText) => onScanSuccess(decodedText),
          () => {}
        )
        .catch(() => {
          showCameraError(readerEl, "Не удалось запустить камеру. Разрешите доступ к камере в браузере.");
        });
    })
    .catch(() => {
      showCameraError(readerEl, "Нет доступа к камере");
    });
}
function showCameraError(readerEl, message) {
  readerEl.innerHTML = `<p class="error">${escapeHtml(message)}</p> <button class="btn-secondary" onclick="retryCamera()">Попробовать снова</button>`;
}
function retryCamera() {
  stopScanner();
  setTimeout(startScanner, 300);
}
function stopScanner() {
  if (html5QrCode) {
    try {
      const result = html5QrCode.stop();
      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (e) {}
    html5QrCode = null;
  }
}
function onScanSuccess(decodedText) {
  stopScanner();
  lookupCode(decodedText.trim());
}
function showManualInput() {
  document.getElementById("manual-input-wrap").style.display = "block";
}
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
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(code)}`, {
      headers: { Authorization: auth },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!data.found) {
      renderNotFound(code);
      return;
    }
    currentResult = data;
    if (data.alreadyShipped) {
      renderAlreadyShipped(data);
    } else if (!data.ready) {
      renderWrongStatus(data);
    } else if (currentRoute && !currentRoute.numbers.includes(data.name)) {
      renderNotInRoute(data);
    } else {
      renderReady(data);
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      body.innerHTML = '<div class="card bad"><div class="badge bad">ДОЛГИЙ ОТВЕТ</div><p>Сервер МойСклад отвечает дольше 15 секунд. Подождите немного и попробуйте снова.</p></div>';
    } else {
      body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Не удалось связаться с сервером. Проверьте интернет.</p></div>';
    }
  }
}
function renderNotFound(code) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">НЕ НАЙДЕНО</div>
    <div class="num">№ ${escapeHtml(code)}</div>
    <p class="meta">Отгрузка с таким номером не найдена.</p>
  </div>`;
}
function renderWrongStatus(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">НЕ ГОТОВО К ОТГРУЗКЕ</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
    <div class="meta">Текущий статус: <b>${escapeHtml(data.stateName || "—")}</b></div>
    <p class="meta">Этот заказ ещё не в статусе "Собрано" — отгружать его сейчас нельзя.</p>
  </div>`;
}
function renderAlreadyShipped(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">УЖЕ ОТГРУЖЕНО</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
    <p class="meta">Этот заказ уже был отсканирован и отгружен ранее.</p>
  </div>`;
}
function renderNotInRoute(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">НЕ В ЭТОМ МАРШРУТЕ</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
    <p class="meta">Заказ собран, но его нет в маршруте "${escapeHtml(currentRoute.type)}".</p>
  </div>`;
}
function renderReady(data) {
  document.getElementById("result-body").innerHTML = `<div class="card ok">
    <div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
    <div class="meta">Позиций в заказе: <b>${escapeHtml(String(data.positionsCount))}</b></div>
    <div class="meta">Количество мест: <b>${escapeHtml(String(data.places ?? "—"))}</b></div>
    <div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div>
  </div>
  <button class="btn-success" onclick="confirmShip()">Отгрузить</button>`;
}
async function confirmShip() {
  if (!currentResult) return;
  const body = document.getElementById("result-body");
  body.innerHTML = '<div class="spinner"></div><p class="hint">Меняю статус…</p>';
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/ship`, {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentResult.id }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.ok) {
      if (currentRoute) {
        currentRoute.scanned.add(currentResult.name);
        saveRouteToStorage();
        renderRouteStatus();
      }
      body.innerHTML = `
        <div class="card ok">
          <div class="badge ok">ОТГРУЖЕНО ✓</div>
          <div class="num">№ ${escapeHtml(currentResult.name)}</div>
          <p class="meta">Статус успешно изменён.</p>
        </div>`;
    } else {
      body.innerHTML = `<div class="card bad"><div class="badge bad">ОШИБКА</div><p>${escapeHtml(data.error || "Не удалось изменить статус")}</p></div>`;
    }
  } catch (e) {
    body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Нет соединения с сервером.</p></div>';
  }
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------- СТАРТ ----------
window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (getSavedAuth()) {
    enterScanScreen();
  } else {
    show("login");
  }
});
