pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedNumbers = [];
let detectedType = null;
let contentDateIso = null;

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- ДАТЫ (принимаем любые форматы) ----------

function isoFromParts(d, m, y) {
  d = Number(d); m = Number(m); y = Number(y);
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// 28062006, 28.06.2026, 28.06.26, 280626, 2806, 28.06, 28-06, 28/06/2026 ...
function parseDateFlexible(text) {
  const s = String(text || "");
  const year = new Date().getFullYear();
  const patterns = [
    [/(?<!\d)(\d{1,2})[.\-_\/ ](\d{1,2})[.\-_\/ ](\d{4})(?!\d)/, (m) => [m[1], m[2], m[3]]],
    [/(?<!\d)(\d{1,2})[.\-_\/ ](\d{1,2})[.\-_\/ ](\d{2})(?!\d)/, (m) => [m[1], m[2], m[3]]],
    [/(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/, (m) => [m[1], m[2], m[3]]],
    [/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/, (m) => [m[1], m[2], m[3]]],
    [/(?<!\d)(\d{1,2})[.\-_\/ ](\d{1,2})(?!\d)/, (m) => [m[1], m[2], year]],
    [/(?<!\d)(\d{2})(\d{2})(?!\d)/, (m) => [m[1], m[2], year]],
  ];
  for (const [re, pick] of patterns) {
    const m = s.match(re);
    if (m) {
      const iso = isoFromParts(...pick(m));
      if (iso) return iso;
    }
  }
  return null;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function getBusinessDayKey(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < 7) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------- ТИП МАРШРУТА ИЗ НАЗВАНИЯ ФАЙЛА ----------

function detectTypeFromName(name) {
  const map = { M: "М", C: "С", K: "К", T: "Т", m: "м", c: "с", k: "к", t: "т" };
  const s = String(name).replace(/[MCKTmckt]/g, (ch) => map[ch]).toLowerCase();
  const hasMsk = /мск/.test(s);
  const hasTk = /тк(?![а-яё])/.test(s);
  if (hasMsk && hasTk) return "AMBIGUOUS";
  if (hasMsk) return "МСК";
  if (hasTk) return "ТК";
  return null;
}

function parseFileName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "");
  const type = detectTypeFromName(base);
  const withoutType = base.replace(/[MCKTmckt\u041c\u0421\u041a\u0422\u043c\u0441\u043a\u0442]{2,3}/g, " ");
  const iso = parseDateFlexible(withoutType);
  return { type, iso };
}

// ---------- ВХОД ----------

function logout() {
  ["collected_session", "collected_user", "collected_expires_at"].forEach((k) => localStorage.removeItem(k));
  $("screen-main").style.display = "none";
  $("screen-login").style.display = "block";
}

function getSavedAuth() {
  const token = localStorage.getItem("collected_session");
  const expires = Number(localStorage.getItem("collected_expires_at") || 0);
  if (!token || !expires || expires <= Date.now()) { logout(); return null; }
  return token;
}

function getSavedUser() { return localStorage.getItem("collected_user") || ""; }

window.addEventListener("load", () => {
  $("route-date").value = fmtDate(getBusinessDayKey());
  $("route-date").addEventListener("change", onDateEdited);
  $("route-date").addEventListener("blur", onDateEdited);
  $("pdf-file").addEventListener("change", handleFile);
  $("history-date").value = getBusinessDayKey();
  if (getSavedAuth()) {
    $("screen-login").style.display = "none";
    $("screen-main").style.display = "block";
  }
});

async function doLogin() {
  const login = $("login-user").value.trim();
  const pass = $("login-pass").value;
  const errEl = $("login-error");
  errEl.textContent = "";
  if (!login || !pass) { errEl.textContent = "Заполните логин и пароль"; return; }
  const authHeader = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/login`, { method: "POST", headers: { Authorization: authHeader }, cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { errEl.textContent = data.error || "Неверный логин или пароль"; return; }
    if (res.status === 403) { errEl.textContent = data.error || "Доступ к приложению запрещён"; return; }
    if (!res.ok || !data.token) { errEl.textContent = data.error || "Не удалось связаться с сервером"; return; }
    localStorage.setItem("collected_session", data.token);
    localStorage.setItem("collected_user", login);
    localStorage.setItem("collected_expires_at", String(Date.now() + Number(data.expiresIn || 0) * 1000));
    $("login-pass").value = "";
    $("screen-login").style.display = "none";
    $("screen-main").style.display = "block";
  } catch (e) { errEl.textContent = "Нет соединения с прокси"; }
}

// ---------- ВЫБОР ФАЙЛА ----------

function hideResult() {
  $("preview-card").style.display = "none";
  $("send-btn").style.display = "none";
  $("send-result").innerHTML = "";
}

function onDateEdited() {
  const iso = parseDateFlexible($("route-date").value);
  if (iso) $("route-date").value = fmtDate(iso);
  updatePreview();
}

function updatePreview() {
  if (!parsedNumbers.length || !detectedType) return;
  const iso = parseDateFlexible($("route-date").value);
  const dateTxt = iso ? fmtDate(iso) : "дата не распознана";
  $("preview-count").textContent = `${detectedType} · ${dateTxt} · отгрузок: ${parsedNumbers.length}`;
  $("send-btn").disabled = !iso;
}

async function handleFile(e) {
  const file = e.target.files[0];
  const statusEl = $("parse-status");
  hideResult();
  parsedNumbers = [];
  detectedType = null;
  contentDateIso = null;
  $("route-label").disabled = false;
  if (!file) { statusEl.textContent = ""; return; }

  const meta = parseFileName(file.name);
  if (meta.type === "AMBIGUOUS") {
    statusEl.innerHTML = '<span class="error">В названии файла указаны и МСК, и ТК. Оставьте только один тип, например: МСК_28.08.pdf</span>';
    return;
  }
  if (!meta.type) {
    statusEl.innerHTML = '<span class="error">В названии файла нет типа маршрута. Переименуйте файл, например: МСК_28.08.pdf или ТК_28.08.2026.pdf</span>';
    return;
  }
  if (!meta.iso) {
    statusEl.innerHTML = '<span class="error">В названии файла нет даты. Переименуйте файл, например: ' + esc(meta.type) + '_28.08.pdf</span>';
    return;
  }

  detectedType = meta.type;
  $("route-label").value = meta.type;
  $("route-label").disabled = true;
  $("route-date").value = fmtDate(meta.iso);
  statusEl.textContent = "Читаю файл…";

  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      fullText += content.items.map((it) => it.str).join(" ") + "\n";
    }

    const found = new Set();
    const re = /(\d{4,7})\s+(?:Да|Нет)\s+\d{2}\.\d{2}\.\d{4}/g;
    let m;
    while ((m = re.exec(fullText)) !== null) found.add(m[1]);
    parsedNumbers = Array.from(found);

    const dm = fullText.match(/период с (\d{2})\.(\d{2})\.(\d{4})/);
    if (dm) contentDateIso = `${dm[3]}-${dm[2]}-${dm[1]}`;

    if (!parsedNumbers.length) {
      statusEl.innerHTML = '<span class="error">Не удалось найти номера отгрузок в файле. Проверьте, что это «Список отгрузок» из МойСклад.</span>';
      return;
    }

    let warn = "";
    if (contentDateIso && contentDateIso !== meta.iso) {
      warn = ` <span style="color:#fbbf24;">Внимание: дата в названии (${fmtDate(meta.iso)}) отличается от даты внутри отчёта (${fmtDate(contentDateIso)}). Проверьте.</span>`;
    }
    statusEl.innerHTML = `<span class="ok-msg">Тип «${esc(meta.type)}» и дата ${fmtDate(meta.iso)} определены по названию файла. Найдено номеров: ${parsedNumbers.length}.</span>${warn}`;
    $("preview-chips").innerHTML = parsedNumbers.map((n) => `<span class="chip">${esc(n)}</span>`).join("");
    $("preview-card").style.display = "block";
    $("send-btn").style.display = "block";
    updatePreview();
  } catch (err) {
    statusEl.innerHTML = '<span class="error">Не удалось прочитать PDF. Убедитесь, что файл не повреждён.</span>';
  }
}

// ---------- ОТПРАВКА ----------

async function sendRoute() {
  const token = getSavedAuth();
  if (!token) return;
  const resultEl = $("send-result");
  const iso = parseDateFlexible($("route-date").value);
  if (!iso) { resultEl.innerHTML = '<p class="error">Дата не распознана. Примеры: 28.08, 2808, 28.08.2026</p>'; return; }
  if (!detectedType || !parsedNumbers.length) { resultEl.innerHTML = '<p class="error">Сначала выберите файл.</p>'; return; }

  const btn = $("send-btn");
  btn.disabled = true;
  resultEl.textContent = "Отправляю…";

  let numbers = [...parsedNumbers];
  let oldCount = 0;

  try {
    if (!$("replace-route").checked) {
      const r = await fetch(`${CONFIG.PROXY_URL}/route?date=${iso}&_=${Date.now()}`, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
      if (r.status === 401) { logout(); return; }
      const d = await r.json();
      if (d.found && Array.isArray(d.items)) {
        const old = d.items.filter((i) => i.label === detectedType).map((i) => i.number);
        oldCount = old.length;
        numbers = [...new Set([...old, ...numbers])];
      }
    }

    const res = await fetch(`${CONFIG.PROXY_URL}/route`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ date: iso, label: detectedType, numbers }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      const added = numbers.length - oldCount;
      resultEl.innerHTML = `<p class="ok-msg">Готово! Маршрут «${esc(detectedType)}» на ${fmtDate(iso)} сохранён: ${numbers.length} отгрузок` +
        (oldCount ? ` (было ${oldCount}, добавлено новых: ${added})` : "") + `.</p>`;
    } else {
      resultEl.innerHTML = `<p class="error">${esc(data.error || "Не удалось отправить маршрут")}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="error">Нет соединения с сервером.</p>';
  } finally {
    btn.disabled = false;
  }
}


// ---------- АРХИВ ОТГРУЖЕННЫХ МАРШРУТОВ ----------

function renderHistoryRoute(label, route) {
  const items = Array.isArray(route.items) ? route.items.filter(i => i.label === label) : [];
  const title = `Маршрут «${esc(label)}» · ${items.length} отгрузок`;
  if (!route.completed) {
    return `<div class="card"><b>${title}</b><p class="hint">Маршрут на эту дату сохранён, но ещё не закрыт полностью.</p></div>`;
  }
  const nums = items.map(i => esc(i.number)).join(", ");
  return `<div class="card"><b>${title}</b><p class="ok-msg">Отгружен: ${route.completedAt ? new Date(route.completedAt).toLocaleString("ru-RU") : "дата не указана"}</p><div class="chip-list">${nums ? nums.split(", ").map(n => `<span class="chip">№ ${n}</span>`).join("") : ""}</div></div>`;
}

async function loadRouteHistory() {
  const token = getSavedAuth();
  if (!token) return;
  const el = $("history-result");
  const date = $("history-date").value;
  if (!date) { el.innerHTML = '<span class="error">Выберите дату.</span>'; return; }
  el.textContent = "Загружаю…";
  try {
    const r = await fetch(`${CONFIG.PROXY_URL}/route?date=${encodeURIComponent(date)}&_=${Date.now()}`, {
      headers: { Authorization: "Bearer " + token }, cache: "no-store"
    });
    if (r.status === 401) { logout(); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { el.innerHTML = `<span class="error">${esc(d.error || "Не удалось загрузить маршрут")}</span>`; return; }
    if (!d.found || !Array.isArray(d.items) || !d.items.length) {
      el.textContent = `На ${fmtDate(date)} маршрутов нет.`;
      return;
    }
    const labels = [...new Set(d.items.map(i => i.label).filter(Boolean))];
    const completedLabels = labels.filter(label => d.completedRoutes?.[label]);
    if (!completedLabels.length) {
      el.textContent = `На ${fmtDate(date)} нет полностью отгруженных маршрутов.`;
      return;
    }
    el.innerHTML = completedLabels.map(label => renderHistoryRoute(label, { ...d, completed: true, completedAt: d.completedRoutes[label] })).join("");
  } catch (e) {
    el.innerHTML = '<span class="error">Нет соединения с сервером.</span>';
  }
}
