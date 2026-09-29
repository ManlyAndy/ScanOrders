// ===========================================================
// Логика страницы логиста: вход, разбор PDF, отправка маршрута
// ===========================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedData = []; // массив {number, places}
let routeTasks = [];
let lastSentRoute = null;

function getSavedAuth() {
  const token = localStorage.getItem("sklad_token");
  return token ? `Bearer ${token}` : null;
}

function getSavedUser() {
  return localStorage.getItem("sklad_user") || "";
}

function logout() {
  localStorage.removeItem("sklad_token");
  localStorage.removeItem("sklad_user");
  document.getElementById("screen-login").style.display = "block";
  document.getElementById("screen-main").style.display = "none";
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
      errEl.textContent = "У вас нет прав логиста";
      return;
    }
    if (!res.ok) {
      errEl.textContent = "Нет соединения с сервером";
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
    errEl.textContent = "Нет соединения с прокси. Проверьте PROXY_URL в config.js";
  }
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
  parsedData = [];

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(it => it.str).join(" ");
      fullText += pageText + "\n";
    }

    const regex = /(\d{4,7})\s+(?:Да|Нет)\s+\d{2}\.\d{2}\.\d{4}/g;
    const found = new Set();
    let m;
    while ((m = regex.exec(fullText)) !== null) {
      found.add(m[1]);
    }

    const numbers = Array.from(found);

    if (!numbers.length) {
      statusEl.innerHTML = 'Не удалось найти номера отгрузок в этом файле. Проверьте, что это именно "Список отгрузок" из МойСклад.';
      return;
    }

    statusEl.textContent = `Найдено номеров: ${numbers.length}. Загружаю данные о местах…`;

    // Параллельно запрашиваем places для каждого номера
    const auth = getSavedAuth();
    const results = await Promise.all(
      numbers.map(async (num) => {
        try {
          const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(num)}`, {
            headers: { Authorization: auth }
          });
          if (!res.ok) return { number: num, places: null };
          const data = await res.json();
          return { number: num, places: data.places || null };
        } catch {
          return { number: num, places: null };
        }
      })
    );

    parsedData = results;

    statusEl.innerHTML = `Найдено номеров: ${parsedData.length}`;
    document.getElementById("preview-count").textContent = `Отгрузки в маршруте (${parsedData.length}):`;
    document.getElementById("preview-chips").innerHTML = parsedData
      .map((d) => `<span class="chip">${d.number}${d.places ? ` (${d.places} мест)` : ""}</span>`)
      .join("");
    document.getElementById("preview-card").style.display = "block";
    document.getElementById("task-btn").style.display = "inline-block";
    document.getElementById("send-btn").style.display = "block";
  } catch (e) {
    statusEl.innerHTML = 'Не удалось прочитать PDF. Убедитесь, что файл не повреждён.';
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

  const numbers = parsedData.map(d => d.number);

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route`, {
      method: "POST",
      headers: { Authorization: getSavedAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ date, label, numbers, tasks: routeTasks }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (data.ok) {
      lastSentRoute = { date, label, items: [...parsedData], tasks: [...routeTasks] };
      document.getElementById("print-btn").style.display = "inline-block";
      resultEl.innerHTML = `Готово! Маршрут "${label}" на ${date} сохранён. Отгрузок: ${data.count}. Заданий: ${routeTasks.length}.`;
    } else {
      resultEl.innerHTML = data.error || "Не удалось отправить маршрут";
    }
  } catch (e) {
    resultEl.innerHTML = 'Нет соединения с сервером.';
  }
}

function printRoute() {
  if (!lastSentRoute) return;
  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r = lastSentRoute;
  const items = r.items.map((d, i) => `<tr><td>${i + 1}</td><td>№ ${esc(d.number)}</td><td>${d.places || "—"}</td></tr>`).join("");
  const tasks = r.tasks.length
    ? r.tasks.map(t => `<li>${esc(t)}</li>`).join("")
    : '<li><em>Дополнительных заданий нет</em></li>';

  const w = window.open("", "_blank");
  if (!w) { alert("Разрешите всплывающие окна для печати маршрута."); return; }
  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Маршрут ${esc(r.label)}</title>
<style>
body{font-family:Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto;}
h1{font-size:20px;margin:0 0 4px;}
.meta{color:#555;margin-bottom:16px;}
table{border-collapse:collapse;width:100%;margin-bottom:20px;}
th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;}
th{background:#f4f4f4;}
h2{font-size:16px;margin:16px 0 6px;}
ul{margin:0;padding-left:20px;}
</style></head><body>
<h1>Маршрут: ${esc(r.label)}</h1>
<div class="meta">Дата: ${esc(r.date)}</div>
<h2>Отгрузки (${r.items.length})</h2>
<table><thead><tr><th>№</th><th>Отгрузка</th><th>Мест</th></tr></thead><tbody>${items}</tbody></table>
<h2>Дополнительные задания</h2>
<ul>${tasks}</ul>
<script>window.onload=()=>window.print();</script>
</body></html>`);
  w.document.close();
}

async function loadHistory() {
  const listEl = document.getElementById("history-list");
  listEl.innerHTML = '<div class="hint">Загружаю…</div>';

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/routes/list`, {
      headers: { Authorization: getSavedAuth() }
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.ok || !data.dates.length) {
      listEl.innerHTML = '<div class="hint">История пуста</div>';
      return;
    }

    listEl.innerHTML = data.dates.map(date => {
      return `<div class="history-item" onclick="showRouteDetails('${date}')">
        <div class="history-date">${date}</div>
        <div class="history-labels">Нажмите для просмотра деталей</div>
      </div>`;
    }).join("");
  } catch (e) {
    listEl.innerHTML = '<div class="hint">Не удалось загрузить историю</div>';
  }
}

async function showRouteDetails(date) {
  const listEl = document.getElementById("history-list");
  listEl.innerHTML = '<div class="hint">Загружаю детали…</div>';

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${date}`, {
      headers: { Authorization: getSavedAuth() }
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.found) {
      listEl.innerHTML = '<div class="hint">Маршрут не найден</div>';
      return;
    }

    const labels = {};
    (data.items || []).forEach(it => {
      if (!labels[it.label]) labels[it.label] = [];
      labels[it.label].push(it.number);
    });

    const tasksByLabel = data.tasksByLabel || {};

    let html = `<div style="margin-bottom:12px;"><strong>Маршрут на ${date}</strong></div>`;
    
    for (const [label, numbers] of Object.entries(labels)) {
      html += `<div class="history-item" style="cursor:default;">
        <div class="history-date">${label} (${numbers.length} отгрузок)</div>
        <div class="history-labels">${numbers.map(n => `№${n}`).join(", ")}</div>`;
      
      if (tasksByLabel[label] && tasksByLabel[label].length) {
        html += `<div style="margin-top:8px;font-size:0.9em;color:#555;"><strong>Задания:</strong> ${tasksByLabel[label].join("; ")}</div>`;
      }
      
      html += `</div>`;
    }

    html += `<button class="btn-secondary" onclick="loadHistory()" style="margin-top:12px;">← Назад к списку дат</button>`;
    listEl.innerHTML = html;
  } catch (e) {
    listEl.innerHTML = '<div class="hint">Не удалось загрузить детали</div>';
  }
}
