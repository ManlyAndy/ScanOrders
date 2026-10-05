// ===========================================================
// Логика приложения. Настройки — в config.js
// ===========================================================
let html5QrCode = null;
let currentResult = null;
let currentRoute = null;
let selectedRouteType = "МСК";
let isScannerActive = false;
let openedFromList = false;
let routeSearch = "";
let tcLoading = false;
let photoReqId = 0;
let photoUrls = [];
let photoBusy = 0;
let warmRunId = 0;

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
  setTimeout(startPrewarm, 3000);
}
function loadRouteFromStorage() {
  const raw = localStorage.getItem(routeStorageKey());
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { date: data.date, type: data.type, numbers: data.numbers, tasks: data.tasks || [], scanned: new Set(data.scanned || []), tcMap: data.tcMap || {}, agentMap: data.agentMap || {}, tcChecked: !!data.tcChecked, tcVersion: data.tcVersion || 0, warmed: data.warmed || [] };
  } catch (e) {
    return null;
  }
}
function saveRouteToStorage(route) {
  route = route || currentRoute;
  if (!route) return;
  localStorage.setItem(
    routeStorageKey(route.type),
    JSON.stringify({
      date: route.date,
      type: route.type,
      numbers: route.numbers,
      tasks: route.tasks || [],
      scanned: Array.from(route.scanned),
      tcMap: route.tcMap || {},
      agentMap: route.agentMap || {},
      tcChecked: !!route.tcChecked,
      tcVersion: route.tcVersion || 0,
      warmed: route.warmed || [],
    })
  );
}
function renderRouteStatus() {
  const el = document.getElementById("route-status");
  const clearBtn = document.getElementById("clear-route-btn");
  const listBtn = document.getElementById("show-list-btn");
  const finishBtn = document.getElementById("finish-route-btn");
  
  if (!currentRoute) {
    el.textContent = `Маршрут "${selectedRouteType}" не загружен — сканирование только по статусу`;
    clearBtn.style.display = "none";
    listBtn.style.display = "none";
    if (finishBtn) finishBtn.style.display = "none";
    return;
  }
  
  el.textContent = `Маршрут "${currentRoute.type}" на ${currentRoute.date}: отсканировано ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
  clearBtn.style.display = "inline-block";
  listBtn.style.display = "block";
  if (finishBtn) finishBtn.style.display = "block";
  renderModalList();
}
function openRouteModal() {
  if (!currentRoute) return;
  routeSearch = "";
  const box = ensureSearchBox();
  box.value = "";
  renderModalList();
  document.getElementById("route-modal").classList.add("active");
  if (currentRoute.type === "ТК" && (!currentRoute.tcChecked || currentRoute.tcVersion !== 2 || !currentRoute.agentMap)) {
    refreshTcMap(null);
  }
}
function closeRouteModal() {
  document.getElementById("route-modal").classList.remove("active");
}
function ensureSearchBox() {
  let box = document.getElementById("route-search");
  if (box) return box;
  const listEl = document.getElementById("modal-list");
  box = document.createElement("input");
  box.type = "text";
  box.id = "route-search";
  box.placeholder = "Поиск по ТК или номеру";
  box.autocomplete = "off";
  box.style.cssText = "width:100%;padding:12px;font-size:16px;border:1px solid #ddd;border-radius:8px;margin-bottom:10px;";
  box.addEventListener("input", function () {
    routeSearch = box.value;
    renderModalList();
  });
  listEl.parentNode.insertBefore(box, listEl);
  return box;
}
function renderModalList() {
  if (!currentRoute) return;
  const listEl = document.getElementById("modal-list");
  ensureSearchBox();
  const tcMap = currentRoute.tcMap || {};
  const agentMap = currentRoute.agentMap || {};
  const q = routeSearch.trim().toLowerCase();

  let nums = [...currentRoute.numbers];
  nums.sort((a, b) => {
    const tcA = tcMap[a] || "Без ТК";
    const tcB = tcMap[b] || "Без ТК";
    const tcCmp = tcA.localeCompare(tcB, "ru", { sensitivity: "base" });
    if (tcCmp) return tcCmp;

    const clientA = agentMap[a] || "";
    const clientB = agentMap[b] || "";
    const clientCmp = clientA.localeCompare(clientB, "ru", { sensitivity: "base" });
    if (clientCmp) return clientCmp;

    const aScanned = currentRoute.scanned.has(a);
    const bScanned = currentRoute.scanned.has(b);
    if (aScanned !== bScanned) return aScanned ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  if (q) {
    nums = nums.filter((n) => {
      const tc = tcMap[n] || "Без ТК";
      const client = agentMap[n] || "";
      return n.toLowerCase().includes(q) || tc.toLowerCase().includes(q) || client.toLowerCase().includes(q);
    });
  }

  if (!nums.length) {
    listEl.innerHTML = '<div class="hint">Ничего не найдено</div>';
  } else {
    const rows = [];
    let lastGroup = null;
    let lastClient = null;
    nums.forEach((num) => {
      const scanned = currentRoute.scanned.has(num);
      const tc = tcMap[num] || "Без ТК";
      const client = agentMap[num] || "Без клиента";
      const groupKey = tc.toLocaleLowerCase();
      const clientKey = client.toLocaleLowerCase();
      if (!q && groupKey !== lastGroup) {
        rows.push(`<div style="margin-top:12px;padding:7px 10px;background:#f0f2f5;border-radius:8px;font-weight:700;">${escapeHtml(tc)}</div>`);
        lastGroup = groupKey;
        lastClient = null;
      }
      if (!q && clientKey !== lastClient) {
        rows.push(`<div style="padding:7px 10px 3px;color:#666;font-size:13px;font-weight:600;">${escapeHtml(client)}</div>`);
        lastClient = clientKey;
      }
      rows.push(`<div class="modal-row ${scanned ? "scanned" : ""}" data-num="${escapeAttr(num)}" onclick="openFromList(this.dataset.num)" style="cursor:pointer;align-items:center;">
        <span>№ ${escapeHtml(num)}${q ? ' <span style="color:#666;">— ' + escapeHtml(tc) + ' — ' + escapeHtml(client) + "</span>" : ""}</span>
        <span><span class="check">${scanned ? "✓" : ""}</span><span style="color:#999;margin-left:10px;">›</span></span>
      </div>`);
    });
    listEl.innerHTML = rows.join("");
  }
  if (!q && currentRoute.tasks && currentRoute.tasks.length) {
    listEl.innerHTML += `<div style="margin-top:14px;font-weight:700;">Доп. задания</div>` +
      currentRoute.tasks.map(t => `<div class="modal-row"><span>ℹ️ ${escapeHtml(t)}</span></div>`).join("");
  }
  const titleEl = document.getElementById("modal-title");
  if (titleEl) titleEl.textContent = `Маршрут "${currentRoute.type}" — ${currentRoute.scanned.size} из ${currentRoute.numbers.length}`;
}
function openFromList(num) {
  if (!num) return;
  closeRouteModal();
  lookupCode(String(num), { fromList: true });
}
async function refreshTcMap(statusEl) {
  if (!currentRoute || tcLoading) return;
  const route = currentRoute;
  if (route.type !== "ТК") return;
  route.tcMap = route.tcMap || {};
  const nums = route.numbers.filter((n) => !route.tcMap[n]);
  if (!nums.length) { route.tcChecked = true; saveRouteToStorage(route); return; }
  tcLoading = true;
  try {
    for (let i = 0; i < nums.length; i += 20) {
      const chunk = nums.slice(i, i + 20);
      if (statusEl) statusEl.textContent = `Загружаю данные о ТК… ${Math.min(i + 20, nums.length)} из ${nums.length}`;
      const res = await fetch(`${CONFIG.PROXY_URL}/route/details`, {
        method: "POST",
        headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ numbers: chunk }),
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) continue;
      const data = await res.json();
      (data.details || []).forEach((d) => {
        route.tcMap[d.number] = d.tc || "";
        route.agentMap[d.number] = d.agentName || "";
      });
      route.tcVersion = 2;
      saveRouteToStorage(route);
      if (currentRoute === route) renderModalList();
    }
    route.tcChecked = true;
    saveRouteToStorage(route);
  } catch (e) {
    // ТК не загрузились — продолжим без них
  } finally {
    tcLoading = false;
    if (currentRoute === route) renderModalList();
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
      scanned: new Set(),
      tcMap: {},
      agentMap: {},
      tcChecked: false,
      tcVersion: 2,
      warmed: []
    };
    saveRouteToStorage();
    await refreshTcMap(el);
    renderRouteStatus();
    startPrewarm();
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
  setTimeout(startPrewarm, 3000);
  setTimeout(startScanner, 300);
}

// ---------- СКАНЕР ----------
function startScanner() {
  if (isScannerActive) return; // Сканер уже работает
  
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
        .then(() => {
          isScannerActive = true;
        })
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
  if (html5QrCode && isScannerActive) {
    try {
      const result = html5QrCode.stop();
      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (e) {}
    html5QrCode = null;
    isScannerActive = false;
  }
}
function onScanSuccess(decodedText) {
  // Игнорируем сканирования, если показан экран результата
  const resultScreen = document.getElementById("screen-result");
  if (resultScreen.classList.contains("active")) return;
  
  lookupCode(decodedText.trim());
}
function showManualInput() {
  document.getElementById("manual-input-wrap").style.display = "block";
}
function submitManual() {
  const code = document.getElementById("manual-input").value.trim();
  if (!code) return;
  lookupCode(code);
}
function backToScan() {
  document.getElementById("manual-input-wrap").style.display = "none";
  document.getElementById("manual-input").value = "";
  photoReqId++;
  show("scan");
  if (openedFromList) {
    openedFromList = false;
    openRouteModal();
  }
}
// ---------- ПОИСК И ОТОБРАЖЕНИЕ ----------
async function lookupCode(code, opts) {
  const fromList = !!(opts && opts.fromList);
  openedFromList = fromList;
  const backBtn = document.querySelector("#screen-result .btn-secondary");
  if (backBtn) backBtn.textContent = fromList ? "← К списку" : "← Сканировать следующий";
  photoReqId++;
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
    
    // Если отгрузка из маршрута - сразу отмечаем её как отсканированную
    if (!fromList && currentRoute && currentRoute.numbers.includes(data.name)) {
      if (!currentRoute.scanned.has(data.name)) {
        currentRoute.scanned.add(data.name);
        saveRouteToStorage();
        renderRouteStatus();
      }
    }
    
    if (data.alreadyShipped) {
      renderAlreadyShipped(data);
    } else if (!data.ready) {
      renderWrongStatus(data);
    } else if (currentRoute && !currentRoute.numbers.includes(data.name)) {
      renderNotInRoute(data);
    } else {
      renderReady(data);
    }
    appendPhotoSection(data.name);
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
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>${data.tc ? `\n    <div class="meta">ТК: <b>${escapeHtml(data.tc)}</b></div>` : ""}
    <div class="meta">Текущий статус: <b>${escapeHtml(data.stateName || "—")}</b></div>
    <p class="meta">Этот заказ ещё не в статусе "Собрано" — отгружать его сейчас нельзя.</p>
  </div>`;
}
function renderAlreadyShipped(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">УЖЕ ОТГРУЖЕНО</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>${data.tc ? `\n    <div class="meta">ТК: <b>${escapeHtml(data.tc)}</b></div>` : ""}
    <p class="meta">Этот заказ уже был отсканирован и отгружен ранее.</p>
  </div>`;
}
function renderNotInRoute(data) {
  document.getElementById("result-body").innerHTML = `<div class="card bad">
    <div class="badge bad">НЕ В ЭТОМ МАРШРУТЕ</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>${data.tc ? `\n    <div class="meta">ТК: <b>${escapeHtml(data.tc)}</b></div>` : ""}
    <p class="meta">Заказ собран, но его нет в маршруте "${escapeHtml(currentRoute.type)}".</p>
  </div>`;
}
function renderReady(data) {
  const wasScanned = currentRoute && currentRoute.numbers.includes(data.name) && currentRoute.scanned.has(data.name);
  const statusText = wasScanned
    ? '<div class="meta" style="color:#2ecc71;font-weight:600;">✓ Отмечена в маршруте</div>'
    : '';
  document.getElementById("result-body").innerHTML = `<div class="card ok">
    <div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div>
    <div class="num">№ ${escapeHtml(data.name)}</div>
    <div class="meta">Покупатель: <b>${escapeHtml(data.agentName)}</b></div>${data.tc ? `\n    <div class="meta">ТК: <b>${escapeHtml(data.tc)}</b></div>` : ""}
    <div class="meta">Позиций в заказе: <b>${escapeHtml(String(data.positionsCount))}</b></div>
    <div class="meta">Количество мест: <b>${escapeHtml(String(data.places ?? "—"))}</b></div>
    <div class="meta">Сумма: <b>${escapeHtml(String(data.sum))} ₽</b></div>
    ${statusText}
  </div>`;
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(String(str)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- ФОТО ИЗ БИТРИКС24 ----------
function appendPhotoSection(number) {
  const body = document.getElementById("result-body");
  if (!body) return;
  const old = document.getElementById("photo-section");
  if (old) old.remove();
  const sec = document.createElement("div");
  sec.id = "photo-section";
  sec.style.marginTop = "16px";
  sec.innerHTML = '<h3 style="margin:0 0 8px;">Фотографии отгрузки</h3><div id="photo-list" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;"><div class="hint" style="grid-column:1/-1">Загрузка фото…</div></div>';
  body.appendChild(sec);
  photoBusy++;
  loadPhotos(number).finally(function () { photoBusy = Math.max(0, photoBusy - 1); });
}
// ---------- ПРОГРЕВ ФОТО В ФОНЕ ----------
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isResultScreenActive() {
  const el = document.getElementById("screen-result");
  return !!(el && el.classList.contains("active"));
}
async function startPrewarm() {
  if (!currentRoute || !getSavedAuth()) return;
  const route = currentRoute;
  const runId = ++warmRunId;
  if (!Array.isArray(route.warmed)) route.warmed = [];
  const warmed = new Set(route.warmed);
  const queue = route.numbers.filter((n) => !route.scanned.has(n))
    .concat(route.numbers.filter((n) => route.scanned.has(n)))
    .filter((n) => !warmed.has(n));
  if (!queue.length) return;
  let errors = 0;
  for (const num of queue) {
    if (runId !== warmRunId || currentRoute !== route || !getSavedAuth()) return;
    while (isResultScreenActive() || photoBusy > 0) {
      await sleepMs(500);
      if (runId !== warmRunId || currentRoute !== route || !getSavedAuth()) return;
    }
    try {
      const res = await fetch(`${CONFIG.PROXY_URL}/photo?number=${encodeURIComponent(num)}&quick=1`, {
        headers: { Authorization: getSavedAuth() },
      });
      if (res.status === 401) return;
      if (res.ok) {
        await res.json().catch(() => ({}));
        route.warmed.push(num);
        saveRouteToStorage(route);
        errors = 0;
      } else if (++errors >= 3) {
        return;
      }
    } catch (e) {
      if (++errors >= 3) return;
    }
    await sleepMs(700);
  }
}
async function fetchPhotoBlob(id, headers) {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${CONFIG.PROXY_URL}/photo/file?id=${encodeURIComponent(id)}`, { headers });
      if (r.ok) return await r.blob();
      if (r.status === 401) { logout(); throw new Error("сессия"); }
      lastErr = "код " + r.status;
      try { const j = await r.json(); if (j && j.error) lastErr = j.error; } catch (e) {}
      if (r.status === 404) break;
    } catch (e) {
      if (e && e.message === "сессия") throw e;
      lastErr = "нет сети";
    }
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
  }
  throw new Error(lastErr || "ошибка");
}
async function loadPhotos(number) {
  const reqId = ++photoReqId;
  photoUrls.forEach((u) => URL.revokeObjectURL(u));
  photoUrls = [];
  const list = document.getElementById("photo-list");
  if (!list) return;
  const headers = { Authorization: getSavedAuth() };
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/photo?number=${encodeURIComponent(number)}`, { headers });
    if (reqId !== photoReqId) return;
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      list.innerHTML = '<div class="hint" style="grid-column:1/-1">Не удалось загрузить фото' + (data.error ? ": " + escapeHtml(data.error) : "") +
        '<br><button class="btn-secondary" style="margin-top:8px" onclick="appendPhotoSection(\'' + escapeAttr(number) + '\')">Повторить</button></div>';
      return;
    }
    const photos = Array.isArray(data.photos) ? data.photos : [];
    if (!photos.length) {
      const d = data.debug || {};
      list.innerHTML = '<div class="hint" style="grid-column:1/-1">Фотографий нет</div>' +
        (d.scanned != null ? '<div class="hint" style="grid-column:1/-1;font-size:12px">Проверено сообщений: ' + d.scanned + ", с файлами: " + d.withFiles + ", с номером: " + d.withText + (d.summary ? "<br>" + escapeHtml(d.summary) : "") + "</div>" : "");
      return;
    }
    list.innerHTML = "";
    const cells = photos.map(() => {
      const c = document.createElement("div");
      c.style.cssText = "background:#e9ecef;border-radius:8px;overflow:hidden;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:12px;color:#777;text-align:center;padding:4px;";
      c.textContent = "Загрузка…";
      list.appendChild(c);
      return c;
    });
    let next = 0;
    async function worker() {
      while (next < photos.length) {
        const idx = next++;
        const p = photos[idx];
        try {
          const blob = await fetchPhotoBlob(p.id, headers);
          if (reqId !== photoReqId) return;
          const src = URL.createObjectURL(blob);
          photoUrls.push(src);
          const img = document.createElement("img");
          img.src = src;
          img.alt = p.name || "";
          img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;cursor:pointer;";
          img.onclick = () => openPhotoViewer(src);
          cells[idx].style.padding = "0";
          cells[idx].textContent = "";
          cells[idx].appendChild(img);
        } catch (e) {
          if (reqId !== photoReqId) return;
          cells[idx].textContent = "Не удалось загрузить: " + ((e && e.message) || "ошибка");
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  } catch (e) {
    if (reqId !== photoReqId) return;
    list.innerHTML = '<div class="hint" style="grid-column:1/-1">Не удалось загрузить фото — проверьте интернет</div>';
  }
}
function openPhotoViewer(src) {
  let v = document.getElementById("photo-viewer");
  if (!v) {
    v = document.createElement("div");
    v.id = "photo-viewer";
    v.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:300;display:none;align-items:center;justify-content:center;";
    v.innerHTML = '<img id="photo-viewer-img" alt="" style="max-width:100%;max-height:100%;object-fit:contain;" />';
    v.onclick = () => { v.style.display = "none"; document.getElementById("photo-viewer-img").src = ""; };
    document.body.appendChild(v);
  }
  document.getElementById("photo-viewer-img").src = src;
  v.style.display = "flex";
}

// ---------- ЗАКРЫТИЕ МАРШРУТА ----------
async function finishRoute() {
  if (!currentRoute) return;
  
  const total = currentRoute.numbers.length;
  const scanned = currentRoute.scanned.size;
  const notScanned = total - scanned;
  
  let message = `Закрыть маршрут "${currentRoute.type}" на ${currentRoute.date}?\n\n`;
  message += `Отсканировано: ${scanned} из ${total}\n`;
  
  if (notScanned > 0) {
    message += `Не отсканировано: ${notScanned}\n\n`;
    message += `Все отсканированные будут переведены в статус "Отгружено".\n`;
    message += `Неотсканированные останутся в статусе "Собрано".`;
  } else {
    message += `Все отгрузки будут переведены в статус "Отгружено".`;
  }
  
  if (!confirm(message)) return;
  
  const btn = document.getElementById("finish-route-btn");
  const originalText = btn.textContent;
  btn.textContent = "Закрываю…";
  btn.disabled = true;
  
  try {
    const idsToShip = [];
    for (const num of currentRoute.scanned) {
      try {
        const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(num)}`, {
          headers: { Authorization: getSavedAuth() }
        });
        if (res.status === 401) { logout(); return; }
        if (res.ok) {
          const data = await res.json();
          if (data.found && data.ready) {
            idsToShip.push(data.id);
          }
        }
      } catch {}
    }
    
    if (idsToShip.length) {
      const finishRes = await fetch(`${CONFIG.PROXY_URL}/finish`, {
        method: "POST",
        headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: idsToShip })
      });
      if (finishRes.status === 401) { logout(); return; }
    }
    
    const completeRes = await fetch(`${CONFIG.PROXY_URL}/route/complete`, {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        date: currentRoute.date,
        label: currentRoute.type,
        scanned: Array.from(currentRoute.scanned)
      })
    });
    
    if (completeRes.status === 401) { logout(); return; }
    const completeData = await completeRes.json();
    
    if (completeData.ok) {
      alert(`Маршрут "${currentRoute.type}" закрыт.\n\nОтсканировано: ${scanned} из ${total}`);
      localStorage.removeItem(routeStorageKey(currentRoute.type));
      currentRoute = null;
      renderRouteStatus();
       } else {
      alert("Не удалось сохранить информацию о закрытии маршрута");
    }
  } catch (e) {
    alert("Ошибка при закрытии маршрута");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
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
