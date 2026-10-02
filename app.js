let html5QrCode = null;
let currentResult = null;
let currentRoute = null;
let selectedRouteType = "МСК";
let isScannerActive = false;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function routeStorageKey(type) { return "sklad_route_" + todayStr() + "_" + (type || selectedRouteType); }

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
    return { date: data.date, type: data.type, numbers: data.numbers, tasks: data.tasks || [], scanned: new Set(data.scanned || []), tcMap: data.tcMap || {} };
  } catch (e) { return null; }
}

function saveRouteToStorage() {
  if (!currentRoute) return;
  localStorage.setItem(routeStorageKey(currentRoute.type), JSON.stringify({
    date: currentRoute.date,
    type: currentRoute.type,
    numbers: currentRoute.numbers,
    tasks: currentRoute.tasks || [],
    scanned: Array.from(currentRoute.scanned),
    tcMap: currentRoute.tcMap || {}
  }));
}

function renderRouteStatus() {
  const el = document.getElementById("route-status");
  const clearBtn = document.getElementById("clear-route-btn");
  const listBtn = document.getElementById("show-list-btn");
  const finishBtn = document.getElementById("finish-route-btn");
  if (!currentRoute) {
    el.textContent = "Маршрут \"" + selectedRouteType + "\" не загружен — сканирование только по статусу";
    clearBtn.style.display = "none";
    listBtn.style.display = "none";
    if (finishBtn) finishBtn.style.display = "none";
    return;
  }
  el.textContent = "Маршрут \"" + currentRoute.type + "\" на " + currentRoute.date + ": отсканировано " + currentRoute.scanned.size + " из " + currentRoute.numbers.length;
  clearBtn.style.display = "inline-block";
  listBtn.style.display = "block";
  if (finishBtn) finishBtn.style.display = "block";
  renderModalList();
}

function openRouteModal() {
  if (!currentRoute) return;
  document.getElementById("modal-title").textContent = "Маршрут \"" + currentRoute.type + "\" — " + currentRoute.scanned.size + " из " + currentRoute.numbers.length;
  renderModalList();
  document.getElementById("route-modal").classList.add("active");
}

function closeRouteModal() {
  document.getElementById("route-modal").classList.remove("active");
}

function renderModalList() {
  if (!currentRoute) return;
  const listEl = document.getElementById("modal-list");
  const tcMap = currentRoute.tcMap || {};
  const sorted = [...currentRoute.numbers].sort(function(a, b) {
    const tcA = tcMap[a] || "";
    const tcB = tcMap[b] || "";
    if (tcA !== tcB) return tcA.localeCompare(tcB);
    const aScanned = currentRoute.scanned.has(a);
    const bScanned = currentRoute.scanned.has(b);
    if (aScanned === bScanned) return a.localeCompare(b, undefined, { numeric: true });
    return aScanned ? 1 : -1;
  });
  listEl.innerHTML = sorted.map(function(num) {
    const scanned = currentRoute.scanned.has(num);
    const tc = tcMap[num] || "";
    return '<div class="modal-row ' + (scanned ? "scanned" : "") + '" onclick="openShipmentFromList(\'' + num + '\')" style="cursor:pointer;">' +
      '<span>№ ' + escapeHtml(num) + (tc ? ' - ' + escapeHtml(tc) : '') + ' - ></span>' +
      '<span class="check">' + (scanned ? "✓" : "") + '</span>' +
      '</div>';
  }).join("");
  if (currentRoute.tasks && currentRoute.tasks.length) {
    listEl.innerHTML += '<div style="margin-top:14px;font-weight:700;">Доп. задания</div>' +
      currentRoute.tasks.map(function(t) { return '<div class="modal-row"><span>ℹ️ ' + escapeHtml(t) + '</span></div>'; }).join("");
  }
  const titleEl = document.getElementById("modal-title");
  if (titleEl) titleEl.textContent = "Маршрут \"" + currentRoute.type + "\" — " + currentRoute.scanned.size + " из " + currentRoute.numbers.length;
}

function openShipmentFromList(num) {
  closeRouteModal();
  lookupCode(num);
}

async function loadRoute() {
  const el = document.getElementById("route-status");
  el.textContent = "Загружаю маршрут…";
  try {
    const res = await fetch(CONFIG.PROXY_URL + "/route?date=" + todayStr(), { headers: { Authorization: getSavedAuth() } });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!data.found) { el.textContent = "Логист ещё не загрузил маршрут на сегодня"; return; }
    const filteredNumbers = (data.items || []).filter(function(it) { return it.label === selectedRouteType; }).map(function(it) { return it.number; });
    if (!filteredNumbers.length) { el.textContent = "На сегодня нет загруженного маршрута типа \"" + selectedRouteType + "\""; return; }
    currentRoute = {
      date: data.date,
      type: selectedRouteType,
      numbers: filteredNumbers,
      tasks: (data.tasksByLabel && data.tasksByLabel[selectedRouteType]) || [],
      scanned: new Set(),
      tcMap: {}
    };
    saveRouteToStorage();
    el.textContent = "Загружаю данные о ТК…";
    try {
      const detailsRes = await fetch(CONFIG.PROXY_URL + "/route/details", {
        method: "POST",
        headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ numbers: filteredNumbers })
      });
      if (detailsRes.ok) {
        const detailsData = await detailsRes.json();
        (detailsData.details || []).forEach(function(d) { if (d.tc) currentRoute.tcMap[d.number] = d.tc; });
        saveRouteToStorage();
      }
    } catch (e) { /* ТК не загрузились — продолжим без них */ }
    renderRouteStatus();
  } catch (e) {
    el.textContent = "Не удалось загрузить маршрут — проверьте интернет";
  }
}

function clearRoute() {
  if (!currentRoute) return;
  const ok = confirm("Сбросить список \"" + currentRoute.type + "\" на этом телефоне?\n\nЭто НЕ меняет статусы в МойСклад — только очищает список на устройстве.");
  if (!ok) return;
  localStorage.removeItem(routeStorageKey(currentRoute.type));
  currentRoute = null;
  renderRouteStatus();
}

function screens() {
  return {
    login: document.getElementById("screen-login"),
    scan: document.getElementById("screen-scan"),
    result: document.getElementById("screen-result")
  };
}

function show(name) {
  const s = screens();
  Object.values(s).forEach(function(el) { el.classList.remove("active"); });
  s[name].classList.add("active");
}

function getSavedAuth() {
  const token = localStorage.getItem("sklad_token");
  return token ? "Bearer " + token : null;
}

function getSavedUser() { return localStorage.getItem("sklad_user") || ""; }

async function doLogin() {
  const login = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!login || !pass) { errEl.textContent = "Заполните логин и пароль"; return; }
  const basicAuth = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));
  try {
    const controller = new AbortController();
    const tid = setTimeout(function() { controller.abort(); }, 10000);
    const res = await fetch(CONFIG.PROXY_URL + "/login", {
      method: "POST",
      headers: { "Authorization": basicAuth, "Content-Type": "application/json" },
      signal: controller.signal
    });
    clearTimeout(tid);
    if (res.status === 401) { errEl.textContent = "Неверный логин или пароль"; return; }
    if (res.status === 403) { errEl.textContent = "Доступ к приложению запрещён"; return; }
    if (!res.ok) { errEl.textContent = "Не удалось связаться с сервером"; return; }
    const data = await res.json();
    if (!data.ok || !data.token) { errEl.textContent = data.error || "Сервер не вернул токен"; return; }
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

function startScanner() {
  if (isScannerActive) return;
  const readerEl = document.getElementById("reader");
  readerEl.innerHTML = "";
  html5QrCode = new Html5Qrcode("reader");
  Html5Qrcode.getCameras().then(function(cameras) {
    if (!cameras || !cameras.length) { showCameraError(readerEl, "Камера не найдена"); return; }
    const backCam = cameras.find(function(c) { return /back|rear|environment/i.test(c.label); }) || cameras[0];
    html5QrCode.start(backCam.id, { fps: 10, qrbox: { width: 220, height: 120 } },
      function(decodedText) { onScanSuccess(decodedText); },
      function() {}
    ).then(function() { isScannerActive = true; })
    .catch(function() { showCameraError(readerEl, "Не удалось запустить камеру. Разрешите доступ к камере в браузере."); });
  }).catch(function() { showCameraError(readerEl, "Нет доступа к камере"); });
}

function showCameraError(readerEl, message) {
  readerEl.innerHTML = '<p class="error">' + escapeHtml(message) + '</p> <button class="btn-secondary" onclick="retryCamera()">Попробовать снова</button>';
}

function retryCamera() { stopScanner(); setTimeout(startScanner, 300); }

function stopScanner() {
  if (html5QrCode && isScannerActive) {
    try {
      const result = html5QrCode.stop();
      if (result && typeof result.catch === "function") result.catch(function() {});
    } catch (e) {}
    html5QrCode = null;
    isScannerActive = false;
  }
}

function onScanSuccess(decodedText) {
  const resultScreen = document.getElementById("screen-result");
  if (resultScreen.classList.contains("active")) return;
  lookupCode(decodedText.trim());
}

function showManualInput() { document.getElementById("manual-input-wrap").style.display = "block"; }

function submitManual() {
  const code = document.getElementById("manual-input").value.trim();
  if (!code) return;
  lookupCode(code);
}

function backToScan() {
  document.getElementById("manual-input-wrap").style.display = "none";
  document.getElementById("manual-input").value = "";
  show("scan");
}

async function lookupCode(code) {
  show("result");
  const body = document.getElementById("result-body");
  body.innerHTML = '<div class="spinner"></div><p class="hint">Ищу отгрузку ' + escapeHtml(code) + '…</p>';
  const auth = getSavedAuth();
  const controller = new AbortController();
  const timeoutId = setTimeout(function() { controller.abort(); }, 15000);
  try {
    const res = await fetch(CONFIG.PROXY_URL + "/find?code=" + encodeURIComponent(code), {
      headers: { Authorization: auth },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!data.found) { renderNotFound(code); return; }
    currentResult = data;
    if (currentRoute && currentRoute.numbers.indexOf(data.name) >= 0) {
      if (!currentRoute.scanned.has(data.name)) {
        currentRoute.scanned.add(data.name);
        saveRouteToStorage();
        renderRouteStatus();
      }
    }
    if (data.alreadyShipped) renderAlreadyShipped(data);
    else if (!data.ready) renderWrongStatus(data);
    else if (currentRoute && currentRoute.numbers.indexOf(data.name) < 0) renderNotInRoute(data);
    else renderReady(data);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") body.innerHTML = '<div class="card bad"><div class="badge bad">ДОЛГИЙ ОТВЕТ</div><p>Сервер МойСклад отвечает дольше 15 секунд. Подождите немного и попробуйте снова.</p></div>';
    else body.innerHTML = '<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Не удалось связаться с сервером. Проверьте интернет.</p></div>';
  }
}

function renderNotFound(code) {
  document.getElementById("result-body").innerHTML = '<div class="card bad"><div class="badge bad">НЕ НАЙДЕНО</div><div class="num">№ ' + escapeHtml(code) + '</div><p class="meta">Отгрузка с таким номером не найдена.</p></div>';
}

function renderWrongStatus(data) {
  document.getElementById("result-body").innerHTML = '<div class="card bad"><div class="badge bad">НЕ ГОТОВО К ОТГРУЗКЕ</div><div class="num">№ ' + escapeHtml(data.name) + '</div><div class="meta">Покупатель: <b>' + escapeHtml(data.agentName) + '</b></div><div class="meta">Текущий статус: <b>' + escapeHtml(data.stateName || "—") + '</b></div><p class="meta">Этот заказ ещё не в статусе "Собрано" — отгружать его сейчас нельзя.</p></div>';
}

function renderAlreadyShipped(data) {
  document.getElementById("result-body").innerHTML = '<div class="card bad"><div class="badge bad">УЖЕ ОТГРУЖЕНО</div><div class="num">№ ' + escapeHtml(data.name) + '</div><div class="meta">Покупатель: <b>' + escapeHtml(data.agentName) + '</b></div><p class="meta">Этот заказ уже был отсканирован и отгружен ранее.</p></div>';
}

function renderNotInRoute(data) {
  document.getElementById("result-body").innerHTML = '<div class="card bad"><div class="badge bad">НЕ В ЭТОМ МАРШРУТЕ</div><div class="num">№ ' + escapeHtml(data.name) + '</div><div class="meta">Покупатель: <b>' + escapeHtml(data.agentName) + '</b></div><p class="meta">Заказ собран, но его нет в маршруте "' + escapeHtml(currentRoute.type) + '".</p></div>';
}

function renderReady(data) {
  const inRoute = currentRoute && currentRoute.numbers.indexOf(data.name) >= 0;
  const wasScanned = inRoute && currentRoute.scanned.has(data.name);
  let statusText = '';
  if (inRoute) statusText = '<div class="meta" style="color:#2ecc71;font-weight:600;">✓ Отмечена в маршруте</div>';
  document.getElementById("result-body").innerHTML =
    '<div class="card ok">' +
    '<div class="badge ok">ГОТОВО К ОТГРУЗКЕ</div>' +
    '<div class="num">№ ' + escapeHtml(data.name) + '</div>' +
    '<div class="meta">Покупатель: <b>' + escapeHtml(data.agentName) + '</b></div>' +
    '<div class="meta">Позиций в заказе: <b>' + escapeHtml(String(data.positionsCount)) + '</b></div>' +
    '<div class="meta">Количество мест: <b>' + escapeHtml(String(data.places !== null && data.places !== undefined ? data.places : "—")) + '</b></div>' +
    '<div class="meta">Сумма: <b>' + escapeHtml(String(data.sum)) + ' ₽</b></div>' +
    (data.tc ? '<div class="meta">ТК: <b>' + escapeHtml(data.tc) + '</b></div>' : '') +
    statusText +
    '</div>' +
    '<div id="photo-section" style="margin-top:16px;">' +
    '<h3 style="margin:0 0 8px;">Фотографии отгрузки</h3>' +
    '<div id="photo-list" style="display:flex;flex-wrap:wrap;gap:8px;">' +
    '<div class="hint">Загрузка фото...</div>' +
    '</div></div>';
  loadPhotos(data.name);
}

async function loadPhotos(number) {
  const photoList = document.getElementById("photo-list");
  if (!photoList) return;
  try {
    const res = await fetch(CONFIG.PROXY_URL + "/photo?number=" + encodeURIComponent(number), {
      headers: { Authorization: getSavedAuth() }
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.photos && data.photos.length > 0) {
      photoList.innerHTML = data.photos.map(function(photo) {
        return '<img src="' + CONFIG.PROXY_URL + '/photo/file?id=' + photo.id + '" alt="' + escapeHtml(photo.name) + '" style="max-width:150px;max-height:150px;border-radius:8px;border:1px solid #ddd;" />';
      }).join("");
    } else {
      photoList.innerHTML = '<div class="hint">Фотографий нет</div>';
    }
  } catch (e) {
    photoList.innerHTML = '<div class="hint">Не удалось загрузить фото</div>';
  }
}

async function finishRoute() {
  if (!currentRoute) return;
  const total = currentRoute.numbers.length;
  const scanned = currentRoute.scanned.size;
  const notScanned = total - scanned;
  let message = "Закрыть маршрут \"" + currentRoute.type + "\" на " + currentRoute.date + "?\n\n";
  message += "Отсканировано: " + scanned + " из " + total + "\n";
  if (notScanned > 0) {
    message += "Не отсканировано: " + notScanned + "\n\n";
    message += "Все отсканированные будут переведены в статус \"Отгружено\".\n";
    message += "Неотсканированные останутся в статусе \"Собрано\".";
  } else {
    message += "Все отгрузки будут переведены в статус \"Отгружено\".";
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
        const res = await fetch(CONFIG.PROXY_URL + "/find?code=" + encodeURIComponent(num), { headers: { Authorization: getSavedAuth() } });
        if (res.status === 401) { logout(); return; }
        if (res.ok) {
          const data = await res.json();
          if (data.found && data.ready) idsToShip.push(data.id);
        }
      } catch {}
    }
    if (idsToShip.length) {
      const finishRes = await fetch(CONFIG.PROXY_URL + "/finish", {
        method: "POST",
        headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: idsToShip })
      });
      if (finishRes.status === 401) { logout(); return; }
    }
    const completeRes = await fetch(CONFIG.PROXY_URL + "/route/complete", {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentRoute.date, label: currentRoute.type, scanned: Array.from(currentRoute.scanned) })
    });
    if (completeRes.status === 401) { logout(); return; }
    const completeData = await completeRes.json();
    if (completeData.ok) {
      alert("Маршрут \"" + currentRoute.type + "\" закрыт.\n\nОтсканировано: " + scanned + " из " + total);
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

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

window.addEventListener("load", function() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function() {});
  if (getSavedAuth()) enterScanScreen();
  else show("login");
});
