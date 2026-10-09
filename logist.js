// ===========================================================
// Логика страницы логиста: вход, разбор PDF, отправка маршрута
// ===========================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedNumbers = [];
let routeTasks = [];
let lastSentRoute = null;

function getSavedAuth() {
  const token = localStorage.getItem("sklad_token");
  return token ? "Bearer " + token : null;
}

window.addEventListener("load", () => {
  document.getElementById("route-date").valueAsDate = new Date();
  if (getSavedAuth()) {
    document.getElementById("screen-login").style.display = "none";
    document.getElementById("screen-main").style.display = "block";
  }
});

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

  localStorage.setItem("sklad_auth", authHeader);
  document.getElementById("screen-login").style.display = "none";
  document.getElementById("screen-main").style.display = "block";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pdf-file").addEventListener("change", handleFile);
});

async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;

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
      resultEl.innerHTML = `<p class="ok-msg">Готово! Маршрут "${label}" на ${date} сохранён. Отгрузок: ${data.count}. Заданий: ${routeTasks.length}.</p>`;
    } else {
      resultEl.innerHTML = `<p class="error">${data.error || "Не удалось отправить маршрут"}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="error">Нет соединения с сервером.</p>';
  }
}

function printRoute() {
  if (!lastSentRoute) return;
  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const r = lastSentRoute;
  const items = r.numbers.map((n, i) => `<tr><td>${i + 1}</td><td>№ ${esc(n)}</td></tr>`).join("");
  const tasks = r.tasks.length ? r.tasks.map(t => `<li>${esc(t)}</li>`).join("") : '<li>Дополнительных заданий нет</li>';
  const w = window.open("", "_blank");
  if (!w) { alert("Разрешите всплывающие окна для печати маршрута."); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Маршрут ${esc(r.label)} ${esc(r.date)}</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:7px;text-align:left}ol,ul{line-height:1.6}@media print{body{padding:10mm}}</style></head><body><h1>Маршрут: ${esc(r.label)}</h1><div>Дата: ${esc(r.date)}</div><h2>Отгрузки (${r.numbers.length})</h2><table><thead><tr><th>№</th><th>Отгрузка</th></tr></thead><tbody>${items}</tbody></table><h2>Дополнительные задания</h2><ul>${tasks}</ul><script>window.onload=()=>window.print();<\\/script></body></html>`);
  w.document.close();
}
