// ===========================================================
// Логика страницы логиста: вход, разбор PDF, отправка маршрута
// ===========================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedNumbers = [];
let routeTasks = [];
let lastSentRoute = null;
let currentFileName = "";

function getSavedAuth() {
  const token = localStorage.getItem("sklad_token");
  return token ? "Bearer " + token : null;
}

window.addEventListener("load", () => {
  document.getElementById("route-date").valueAsDate = new Date();
  const hd = document.getElementById("history-date");
  if (hd) hd.value = localDateStr();
  if (getSavedAuth()) {
    document.getElementById("screen-login").style.display = "none";
    document.getElementById("screen-main").style.display = "block";
  }
});

function logout() {
  localStorage.removeItem("sklad_token");
  localStorage.removeItem("sklad_user");
  document.getElementById("screen-login").style.display = "block";
  document.getElementById("screen-main").style.display = "none";
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
    const res = await fetch(CONFIG.PROXY_URL + "/login", {
      method: "POST",
      headers: {
        "Authorization": basicAuth,
        "Content-Type": "application/json"
      }
    });

    if (res.status === 401) {
      errEl.textContent = "Неверный логин или пароль";
      return;
    }
    if (res.status === 403) {
      errEl.textContent = "У вас нет прав логиста";
      return;
    }
    if (!res.ok) {
      errEl.textContent = "Ошибка сервера (код " + res.status + ")";
      return;
    }

    const data = await res.json();
    if (!data.ok || !data.token) {
      errEl.textContent = data.error || "Сервер не вернул токен";
      return;
    }

    localStorage.setItem("sklad_token", data.token);
    localStorage.setItem("sklad_user", data.user || login);
    document.getElementById("screen-login").style.display = "none";
    document.getElementById("screen-main").style.display = "block";
  } catch (e) {
    errEl.textContent = "Нет соединения с сервером. Проверьте PROXY_URL в config.js";
  }
}

// ---------- Проверка имени файла: тип маршрута и дата должны совпадать с выбранными ----------
const LATIN_TO_CYR = { A:"А", B:"В", C:"С", E:"Е", H:"Н", K:"К", M:"М", O:"О", P:"Р", S:"С", T:"Т", X:"Х" };
function normalizeToken(t) {
  return String(t).toUpperCase().replace(/[A-Z]/g, (c) => LATIN_TO_CYR[c] || c);
}
function routeTypeFromFilename(name) {
  const base = String(name || "").replace(/\.[^.]*$/, "");
  const tokens = base.split(/[^A-Za-zА-Яа-яЁё0-9]+/).filter(Boolean).map(normalizeToken);
  const types = { "МСК": "МСК", "ТК": "ТК", "НАЙМ": "Найм" };
  const found = [];
  tokens.forEach((t) => { if (types[t] && found.indexOf(types[t]) < 0) found.push(types[t]); });
  return found;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function datesFromFilename(name) {
  const base = String(name || "").replace(/\.[^.]*$/, "");
  const out = [];
  let m;
  // без lookbehind — он не поддерживается в старых версиях Safari на iPhone
  const reIsoLike = /(?:^|\D)(\d{4})[-._](\d{1,2})[-._](\d{1,2})(?!\d)/g;
  while ((m = reIsoLike.exec(base)) !== null) out.push(`${m[1]}-${pad2(m[2])}-${pad2(m[3])}`);
  const reRu = /(?:^|\D)(\d{1,2})[-._](\d{1,2})[-._](\d{4}|\d{2})(?!\d)/g;
  while ((m = reRu.exec(base)) !== null) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    out.push(`${y}-${pad2(m[2])}-${pad2(m[1])}`);
  }
  return out;
}
function fileMismatchMessage() {
  if (!currentFileName) return "";
  const date = document.getElementById("route-date").value;
  const label = document.getElementById("route-label").value.trim();
  const types = routeTypeFromFilename(currentFileName);
  if (types.length && types.indexOf(label) < 0) {
    return `Файл «${currentFileName}» относится к маршруту «${types.join(", ")}», а выбран тип «${label}». Выберите нужный тип или другой файл.`;
  }
  const dates = datesFromFilename(currentFileName);
  if (dates.length && dates.indexOf(date) < 0) {
    return `В названии файла «${currentFileName}» указана дата ${dates.join(", ")}, а выбрана ${date}. Исправьте дату или выберите другой файл.`;
  }
  return "";
}
// Показывает/скрывает кнопку отправки в зависимости от совпадения файла и выбранных значений
function refreshSendState() {
  const sendBtn = document.getElementById("send-btn");
  const statusEl = document.getElementById("parse-status");
  if (!parsedNumbers.length) return;
  const msg = fileMismatchMessage();
  if (msg) {
    sendBtn.style.display = "none";
    statusEl.innerHTML = `<span class="error" style="background:#fff;padding:6px 8px;border-radius:6px;display:inline-block">⛔ ${msg.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}</span>`;
  } else {
    sendBtn.style.display = "block";
    statusEl.innerHTML = `<span class="ok-msg">Найдено номеров: ${parsedNumbers.length}</span>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pdf-file").addEventListener("change", handleFile);
  document.getElementById("route-date").addEventListener("change", refreshSendState);
  document.getElementById("route-label").addEventListener("change", refreshSendState);
  addRouteManageButtons();
});

// Кнопки "Очистить" (до отправки) и "Удалить маршрут" (после отправки)
function addRouteManageButtons() {
  const anchor = document.getElementById("send-result");
  if (!anchor || document.getElementById("manage-box")) return;
  const box = document.createElement("div");
  box.id = "manage-box";
  box.style.marginTop = "10px";
  box.innerHTML =
    '<button class="btn-secondary" id="clear-btn" style="background:rgba(255,255,255,0.2);color:white;">Очистить</button>' +
    '<button class="btn-secondary" id="delete-route-btn" style="background:rgba(231,76,60,0.9);color:white;">Удалить маршрут</button>';
  anchor.insertAdjacentElement("beforebegin", box);
  document.getElementById("clear-btn").addEventListener("click", clearForm);
  document.getElementById("delete-route-btn").addEventListener("click", deleteRoute);
}

function clearForm() {
  parsedNumbers = [];
  routeTasks = [];
  lastSentRoute = null;
  currentFileName = "";
  document.getElementById("pdf-file").value = "";
  document.getElementById("parse-status").textContent = "";
  document.getElementById("preview-card").style.display = "none";
  document.getElementById("preview-chips").innerHTML = "";
  document.getElementById("task-preview").textContent = "";
  document.getElementById("send-result").textContent = "";
  document.getElementById("send-btn").style.display = "none";
  document.getElementById("task-btn").style.display = "none";
  document.getElementById("print-btn").style.display = "none";
}

async function deleteRoute() {
  const date = document.getElementById("route-date").value;
  const label = document.getElementById("route-label").value.trim();
  const resultEl = document.getElementById("send-result");
  if (!date || !label) return;
  const headers = { Authorization: getSavedAuth(), "Content-Type": "application/json" };

  try {
    // Сколько отгрузок сейчас в этом маршруте
    const g = await fetch(`${CONFIG.PROXY_URL}/route?date=${encodeURIComponent(date)}`, { headers });
    if (g.status === 401) { logout(); return; }
    const gd = await g.json().catch(() => ({}));
    const have = (gd.items || []).filter((it) => it.label === label).length;
    if (!have) {
      resultEl.innerHTML = `<p class="error" style="background:#fff;padding:6px 8px;border-radius:6px;display:inline-block">Маршрута «${label}» на ${date} нет — удалять нечего.</p>`;
      return;
    }
    if (!confirm(`Удалить маршрут «${label}» на ${date}?\nБудет удалено отгрузок: ${have}. Остальные маршруты этого дня не изменятся. Действие нельзя отменить.`)) return;

    resultEl.textContent = "Удаляю…";
    const res = await fetch(`${CONFIG.PROXY_URL}/route/delete`, {
      method: "POST", headers, body: JSON.stringify({ date, label }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      lastSentRoute = null;
      document.getElementById("print-btn").style.display = "none";
      resultEl.innerHTML = `<p class="ok-msg">Маршрут «${label}» на ${date} удалён (отгрузок: ${data.removed}). Осталось на этот день в других маршрутах: ${data.count}.</p>`;
    } else {
      resultEl.innerHTML = `<p class="error" style="background:#fff;padding:6px 8px;border-radius:6px;display:inline-block">${data.error || "Не удалось удалить маршрут"}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="error" style="background:#fff;padding:6px 8px;border-radius:6px;display:inline-block">Нет соединения с сервером.</p>';
  }
}

async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  currentFileName = file.name || "";
  parsedNumbers = [];
  const statusEl = document.getElementById("parse-status");
  statusEl.textContent = "Читаю файл…";
  document.getElementById("preview-card").style.display = "none";
  document.getElementById("send-btn").style.display = "none";
  document.getElementById("task-btn").style.display = "none";
  document.getElementById("print-btn").style.display = "none";
  document.getElementById("task-preview").textContent = "";
  routeTasks = [];
  lastSentRoute = null;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it) => it.str).join(" ");
      fullText += pageText + "\n";
    }

    // Номер отгрузки: число, за которым идёт "Да" или "Нет" и дата ДД.ММ.ГГГГ
    const regex = /(\d{4,7})\s+(?:Да|Нет)\s+\d{2}\.\d{2}\.\d{4}/g;
    const found = new Set();
    let m;
    while ((m = regex.exec(fullText)) !== null) {
      found.add(m[1]);
    }

    parsedNumbers = Array.from(found);

    if (!parsedNumbers.length) {
      statusEl.innerHTML = '<span class="error">Не удалось найти номера отгрузок в этом файле. Проверьте, что это именно "Список отгрузок" из МойСклад.</span>';
      return;
    }

    statusEl.innerHTML = `<span class="ok-msg">Найдено номеров: ${parsedNumbers.length}</span>`;
    document.getElementById("preview-count").textContent = `Отгрузки в маршруте (${parsedNumbers.length}):`;
    document.getElementById("preview-chips").innerHTML = parsedNumbers
      .map((n) => `<span class="chip">${n}</span>`)
      .join("");
    document.getElementById("preview-card").style.display = "block";
    document.getElementById("task-btn").style.display = "inline-block";
    document.getElementById("send-btn").style.display = "block";
    refreshSendState();
  } catch (e) {
    statusEl.innerHTML = '<span class="error">Не удалось прочитать PDF. Убедитесь, что файл не повреждён.</span>';
  }
}

function openTaskModal() {
  document.getElementById("task-input").value = routeTasks.join("\n");
  document.getElementById("task-modal").style.display = "flex";
}

function closeTaskModal() {
  document.getElementById("task-modal").style.display = "none";
}

function saveTasks() {
  routeTasks = document.getElementById("task-input").value
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  document.getElementById("task-preview").textContent = routeTasks.length
    ? `Доп. заданий: ${routeTasks.length}`
    : "Доп. заданий нет";
  closeTaskModal();
}

async function sendRoute() {
  const date = document.getElementById("route-date").value;
  const label = document.getElementById("route-label").value.trim();
  const resultEl = document.getElementById("send-result");
  const mismatch = fileMismatchMessage();
  if (mismatch) {
    refreshSendState();
    alert(mismatch);
    return;
  }
  resultEl.textContent = "Отправляю…";

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route`, {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ date, label, numbers: parsedNumbers, tasks: routeTasks }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (data.ok) {
      lastSentRoute = { date, label, numbers: [...parsedNumbers], tasks: [...routeTasks] };
      document.getElementById("print-btn").style.display = "inline-block";
      resultEl.innerHTML = `<p class="ok-msg">Готово! Маршрут "${label}" на ${date} сохранён. Отгрузок в этом маршруте: ${parsedNumbers.length}${data.count != null && data.count !== parsedNumbers.length ? ` (всего за день по всем маршрутам: ${data.count})` : ""}. Заданий: ${routeTasks.length}.</p>`;
    } else {
      resultEl.innerHTML = `<p class="error">${data.error || "Не удалось отправить маршрут"}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="error">Нет соединения с сервером.</p>';
  }
}

// Места, описание, ТК, контрагент и статус по номерам.
// Пачки по 20: на каждый номер воркер делает 2 запроса к МойСклад, а лимит подзапросов один запрос к воркеру ограничен.
async function fetchRouteDetails(numbers, onChunk) {
  const map = {};
  numbers.forEach((n) => {
    map[String(n)] = {
      number: String(n),
      tc: "",
      clientName: "",
      agentName: "",
      places: null,
      description: "",
      stateName: ""
    };
  });

  for (let i = 0; i < numbers.length; i += 20) {
    const chunk = numbers.slice(i, i + 20);
    try {
      const res = await fetch(`${CONFIG.PROXY_URL}/route/details`, {
        method: "POST",
        headers: {
          Authorization: getSavedAuth(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ numbers: chunk })
      });

      if (res.status === 401) {
        logout();
        return map;
      }
      if (!res.ok) continue;

      const data = await res.json();
      (data.details || []).forEach((d) => {
        const key = String(d.number);
        map[key] = {
          ...(map[key] || {}),
          ...d,
          number: key,
          tc: d.tc || "",
          clientName: d.clientName || d.agentName || "",
          agentName: d.agentName || d.clientName || "",
          places: d.places == null ? null : d.places,
          description: d.description || ""
        };
      });

      if (onChunk) onChunk(map);
    } catch (e) {
      // Сохраняем номера даже при временной ошибке получения данных.
    }
  }

  return map;
}

// Сортировка: ТК (по алфавиту, без ТК в конце), внутри ТК клиент, затем номер отгрузки
function sortRouteRows(rows) {
  const cmp = (a, b) => String(a).localeCompare(String(b), "ru", { sensitivity: "base", numeric: true });
  return rows.sort((a, b) => {
    if (a.tc !== b.tc) {
      if (!a.tc) return 1;
      if (!b.tc) return -1;
      return cmp(a.tc, b.tc);
    }
    if (a.client !== b.client) return cmp(a.client, b.client);
    return cmp(a.n, b.n);
  });
}

async function printRoute() {
  if (!lastSentRoute) return;
  const r = lastSentRoute;
  const w = window.open("", "_blank");
  if (!w) { alert("Разрешите всплывающие окна для печати маршрута."); return; }
  w.document.write("<!doctype html><meta charset='utf-8'><p style='font-family:Arial;padding:28px'>Загружаю данные для печати…</p>");

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const details = await fetchRouteDetails(r.numbers);

  const rows = r.numbers.map((n) => {
    const d = details[String(n)] || {};
    return {
      n: String(n),
      tc: (d.tc || "").trim(),
      client: (d.agentName || d.clientName || d.counterparty || "").trim(),
      places: d.places == null ? "" : d.places,
      description: d.description || "",
    };
  });
  sortRouteRows(rows);
  const items = rows.map((x, i) =>
    `<tr><td>${i + 1}</td><td>№ ${esc(x.n)}</td><td>${esc(x.tc)}</td><td>${esc(x.client)}</td><td>${esc(x.places)}</td><td>${esc(x.description)}</td></tr>`
  ).join("");
  const tasks = r.tasks.length ? r.tasks.map(t => `<li>${esc(t)}</li>`).join("") : '<li>Дополнительных заданий нет</li>';

  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Маршрут ${esc(r.label)} ${esc(r.date)}</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:7px;text-align:left;vertical-align:top}ol,ul{line-height:1.6}@media print{body{padding:0}}</style></head><body><h1>Маршрут: ${esc(r.label)}</h1><div>Дата: ${esc(r.date)}</div><h2>Отгрузки (${r.numbers.length})</h2><table><thead><tr><th>№</th><th>Отгрузка</th><th>ТК</th><th>Контрагент</th><th>Места</th><th>Описание</th></tr></thead><tbody>${items}</tbody></table><h2>Дополнительные задания</h2><ul>${tasks}</ul><script>window.onload=()=>window.print();<\/script></body></html>`);
  w.document.close();
}


// ---------- История маршрутов ----------
let historyReqId = 0;

function localDateStr(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function escHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function statusBadgeHtml(stateName) {
  if (!stateName) return "";
  let cls = "status-other";
  if (stateName === "Отгружено") cls = "status-shipped";
  else if (stateName === "Собрано") cls = "status-ready";
  return `<span class="status-badge ${cls}">${escHtml(stateName)}</span>`;
}
function formatDoneTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}

async function showHistoryForDate() {
  const date = document.getElementById("history-date").value;
  const listEl = document.getElementById("history-list");
  if (!date) { listEl.innerHTML = '<p class="hint">Выберите дату.</p>'; return; }
  const reqId = ++historyReqId;
  listEl.innerHTML = '<p class="hint">Загружаю маршруты…</p>';

  let data;
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${encodeURIComponent(date)}`, {
      headers: { Authorization: getSavedAuth() },
    });
    if (res.status === 401) { logout(); return; }
    data = await res.json().catch(() => ({}));
    if (reqId !== historyReqId) return;
    if (!res.ok) {
      listEl.innerHTML = `<p class="error">${escHtml(data.error || "Не удалось загрузить маршруты")}</p>`;
      return;
    }
  } catch (e) {
    if (reqId !== historyReqId) return;
    listEl.innerHTML = '<p class="error">Нет соединения с сервером.</p>';
    return;
  }

  const items = Array.isArray(data.items) ? data.items : [];
  if (!data.found || !items.length) {
    listEl.innerHTML = `<p class="hint">На ${escHtml(date)} маршрутов нет.</p>`;
    return;
  }

  // группировка по типу маршрута: МСК, ТК, Найм, затем остальные
  const groups = {};
  items.forEach((it) => { (groups[it.label] = groups[it.label] || []).push(String(it.number)); });
  const preferred = ["МСК", "ТК", "Найм"];
  const labels = preferred.filter((l) => groups[l]).concat(Object.keys(groups).filter((l) => preferred.indexOf(l) < 0));
  const completed = (data.completedRoutes && typeof data.completedRoutes === "object") ? data.completedRoutes : {};
  const allNumbers = items.map((it) => String(it.number));

  function render(details, loading) {
    let html = `<div class="hint">Дата: ${escHtml(date)}. Отгрузок всего: ${allNumbers.length}.` +
      (loading ? " Загружаю контрагентов и статусы…" : "") + "</div>";
    labels.forEach((label) => {
      const nums = groups[label];
      const done = completed[label];
      const scannedSet = new Set(done && Array.isArray(done.scanned) ? done.scanned.map(String) : []);
      const rows = sortRouteRows(nums.map((n) => {
        const d = details[n] || {};
        return {
          n: n,
          tc: (d.tc || "").trim(),
          client: (d.agentName || d.clientName || d.counterparty || "").trim(),
          state: d.stateName || "",
          scanned: scannedSet.has(n),
        };
      }));

      const counts = {};
      rows.forEach((r) => { if (r.state) counts[r.state] = (counts[r.state] || 0) + 1; });
      const summary = Object.keys(counts).map((k) => `${escHtml(k)}: ${counts[k]}`).join(" · ");

      const doneBadge = done
        ? `<span class="status-badge status-shipped">Закрыт ${escHtml(formatDoneTime(done.completedAt))} · отсканировано ${scannedSet.size} из ${nums.length}</span>`
        : '<span class="status-badge status-other">Не закрыт</span>';

      const body = rows.map((r) => {
        const meta = [r.tc, r.client].filter(Boolean).map(escHtml).join(" · ");
        return `<div style="padding:6px 0;border-top:1px solid #eee;font-size:14px;">` +
          `№ ${escHtml(r.n)}` +
          (meta ? ` <span style="color:#666;">— ${meta}</span>` : "") +
          (r.scanned ? ' <span style="color:#2ecc71;font-weight:700;">✓</span>' : "") +
          statusBadgeHtml(r.state) +
          `</div>`;
      }).join("");

      html += `<div class="history-item">` +
        `<div class="history-date">${escHtml(label)} — отгрузок: ${nums.length} ${doneBadge}</div>` +
        (summary ? `<div class="history-labels">${summary}</div>` : "") +
        `<div style="margin-top:6px;">${body}</div></div>`;
    });
    listEl.innerHTML = html;
  }

  render({}, true);
  const details = await fetchRouteDetails(allNumbers, (partial) => {
    if (reqId === historyReqId) render(partial, true);
  });
  if (reqId === historyReqId) render(details, false);
}
