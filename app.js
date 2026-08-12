// ===========================================================
// Логика приложения. Настройки — в config.js
// ===========================================================

let html5QrCode = null;
let currentResult = null;
let currentRoute = null; // { date, numbers: [...], scanned: Set }

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function routeStorageKey() {
  return "sklad_route_" + todayStr();
}

function loadRouteFromStorage() {
  const raw = localStorage.getItem(routeStorageKey());
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { date: data.date, numbers: data.numbers, scanned: new Set(data.scanned || []) };
  } catch (e) {
    return null;
  }
}

function saveRouteToStorage() {
  if (!currentRoute) return;
  localStorage.setItem(
    routeStorageKey(),
    JSON.stringify({
      date: currentRoute.date,
      numbers: currentRoute.numbers,
      scanned: Array.from(currentRoute.scanned),
    })
  );
}

function renderRouteStatus() {
  const el = document.getElementById("route-status");
  const clearBtn = document.getElementById("clear-route-btn");
  if (!currentRoute) {
    el.textContent = "Маршрут не загружен";
    clearBtn.style.display = "none";
    return;
  }
  el.textContent = `Маршрут на ${currentRoute.date}: отсканировано ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
  clearBtn.style.display = "inline-block";
}

async function loadRoute() {
  const el = document.getElementById("route-status");
  el.textContent = "Загружаю маршрут…";
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${todayStr()}`, {
      headers: { Authorization: getSavedAuth() },
    });
    const data = await res.json();

    if (!data.found) {
      el.textContent = "Логист ещё не загрузил маршрут на сегодня";
      return;
    }

    currentRoute = { date: data.date, numbers: data.numbers, scanned: new Set() };
    saveRouteToStorage();
    renderRouteStatus();
  } catch (e) {
    el.textContent = "Не удалось загрузить маршрут — проверьте интернет";
  }
}

function clearRoute() {
  currentRoute = null;
  localStorage.removeItem(routeStorageKey());
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
  return localStorage.getItem("sklad_auth"); // хранит "Basic base64(login:pass)"
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
    errEl.textContent = "логин и пароль";
    return;
  }

  const authHeader = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));

  // Проверяем логин/пароль лёгким запросом через прокси (ищем заведомо несуществующий номер)
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=__login_check__`, {
      headers: { Authorization: authHeader },
    });
    if (res.status === 401) {
      errEl.textContent = "Неверный логин или пароль";
      return;
    }
    if (!res.ok) {
      errEl.textContent = "Не удалось связаться с сервером. Проверьте адрес прокси в config.js";
      return;
    }
  } catch (e) {
    errEl.textContent = "Нет соединения с прокси. Проверьте PROXY_URL в config.js";
    return;
  }

  localStorage.setItem("sklad_auth", authHeader);
  localStorage.setItem("sklad_user", login);
  enterScanScreen();
}

function logout() {
  localStorage.removeItem("sklad_auth");
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
  startScanner();
}

// ---------- СКАНЕР ----------

function startScanner() {
  const readerEl = document.getElementById("reader");
  readerEl.innerHTML = "";
  html5QrCode = new Html5Qrcode("reader");

  Html5Qrcode.getCameras()
    .then((cameras) => {
      if (!cameras || !cameras.length) {
        readerEl.innerHTML = '<p class="error">Камера не найдена</p>';
        return;
      }
      // Предпочитаем заднюю камеру
      const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[0];
      html5QrCode
        .start(
          backCam.id,
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText) => onScanSuccess(decodedText),
          () => {} // ошибки отдельных кадров игнорируем
        )
        .catch(() => {
          readerEl.innerHTML = '<p class="error">Не удалось запустить камеру. Разрешите доступ к камере в браузере.</p>';
        });
    })
    .catch(() => {
      readerEl.innerHTML = '<p class="error">Нет доступа к камере</p>';
    });
}

function stopScanner() {
  if (html5QrCode) {
    html5QrCode.stop().catch(() => {});
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
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(code)}`, {
      headers: { Authorization: auth },
    });

    if (res.status === 401) {
      logout();
      return;
    }

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
    body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Не удалось связаться с сервером. Проверьте интернет.</p></div>';
  }
}

function renderNotFound(code) {
  document.getElementById("result-body").innerHTML = `
    <div class="card bad">
      <div class="badge bad">НЕ НАЙДЕНО</div>
      <div class="num">№ ${escapeHtml(code)}</div>
      <p class="meta">Отгрузка с таким номером не найдена</p>
    </div>`;
}

function renderWrongStatus(data) {
  document.getElementById("result-body").innerHTML = `
    <div class="card bad">
      <div class="badge bad">НЕ ГОТОВО К ОТГРУЗКЕ</div>
      <div class="num">№ ${escapeHtml(data.name)}</div>
      <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
      <div class="meta">Текущий статус: <b>${escapeHtml(data.stateName || "—")}</b></div>
      <p class="meta">Этот заказ ещё не в статусе "Собрано"</p>
    </div>`;
}

function renderAlreadyShipped(data) {
  document.getElementById("result-body").innerHTML = `
    <div class="card bad">
      <div class="badge bad">УЖЕ ОТГРУЖЕНО</div>
      <div class="num">№ ${escapeHtml(data.name)}</div>
      <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
      <p class="meta">Этот заказ уже был отсканирован</p>
    </div>`;
}

function renderNotInRoute(data) {
  document.getElementById("result-body").innerHTML = `
    <div class="card bad">
      <div class="badge bad">НЕ В ЭТОМ МАРШРУТЕ</div>
      <div class="num">№ ${escapeHtml(data.name)}</div>
      <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
      <p class="meta">Заказ собран, но его нет в загруженном сегодняшнем маршруте</p>
    </div>`;
}

function renderReady(data) {
  document.getElementById("result-body").innerHTML = `
    <div class="card ok">
      <div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div>
      <div class="num">№ ${escapeHtml(data.name)}</div>
      <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>
      <div class="meta">Позиций в заказе: <b>${escapeHtml(String(data.positionsCount))}</b></div>
      <div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div>
    </div>
    <button class="btn-success" onclick="confirmShip()">Отгрузить</button>
  `;
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
