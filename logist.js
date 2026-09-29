// ===========================================================
// Логика страницы логиста: вход, разбор PDF, отправка маршрута, история
// ===========================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedData = []; // [{number, places}]
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
  const historyDateEl = document.getElementById("history-date");
  if (historyDateEl) historyDateEl.valueAsDate = new Date();
  
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
      statusEl.innerHTML = 'Не удалось найти номера отгрузок в этом файле.';
      return;
    }

    statusEl.textContent = `Найдено номеров: ${numbers.length}. Загружаю данные о местах…`;

    const auth = getSavedAuth();
   const results = await Promise.all(
      numbers.map(async (num) => {
        try {
          const res = await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(num)}`, {
            headers: { Authorization: auth }
          });
          if (!res.ok) return { number: num, places: null, address: "" };
          const data = await res.json();
          return { number: num, places: data.places || null, address: data.deliveryAddress || "" };
        } catch {
          return { number: num, places: null, address: "" };
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
    statusEl.innerHTML = 'Не удалось прочитать PDF.';
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
  const esc = (v) => String(v || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r = lastSentRoute;
  
  const items = r.items.map((d) => `<tr>
    <td class="col-num">№ ${esc(d.number)}</td>
    <td class="col-places">${d.places ?? "—"}</td>
    <td class="col-address">${esc(d.address) || "—"}</td>
  </tr>`).join("");
  
  const tasks = r.tasks.length
    ? r.tasks.map(t => `<li>${esc(t)}</li>`).join("")
    : '<li><em>Дополнительных заданий нет</em></li>';

  const w = window.open("", "_blank");
  if (!w) { alert("Разрешите всплывающие окна для печати маршрута."); return; }
  
  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Маршрут ${esc(r.label)}</title>
<style>
  @page { margin: 10mm; size: A4 landscape; }
  body { font-family: Arial, sans-serif; padding: 10px; font-size: 11px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 12px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  th, td { border: 1px solid #999; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 700; }
  .col-num { width: 90px; white-space: nowrap; }
  .col-places { width: 60px; text-align: center; }
  .col-address { width: auto; }
  h2 { font-size: 13px; margin: 14px 0 6px; }
  ul { margin: 0; padding-left: 20px; }
  @media print {
    body { padding: 0; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
  }
</style></head><body>
<h1>Маршрут: ${esc(r.label)}</h1>
<div class="meta">Дата: ${esc(r.date)}</div>
<h2>Отгрузки (${r.items.length})</h2>
<table>
  <thead><tr><th>Отгрузка</th><th>Мест</th><th>Адрес доставки</th></tr></thead>
  <tbody>${items}</tbody>
</table>
<h2>Дополнительные задания</h2>
<ul>${tasks}</ul>
<script>window.onload=()=>window.print();<\/script>
</body></html>`);
  w.document.close();
}

async function showHistoryForDate() {
  const date = document.getElementById("history-date").value;
  const listEl = document.getElementById("history-list");
  
  if (!date) {
    listEl.innerHTML = '<div class="hint">Выберите дату</div>';
    return;
  }
  
  listEl.innerHTML = '<div class="hint">Загружаю маршрут…</div>';

  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/route?date=${date}`, {
      headers: { Authorization: getSavedAuth() }
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (!data.found) {
      listEl.innerHTML = `<div class="hint">На ${date} маршрутов не найдено</div>`;
      return;
    }

    const labels = {};
    (data.items || []).forEach(it => {
      if (!labels[it.label]) labels[it.label] = [];
      labels[it.label].push(it.number);
    });

    const tasksByLabel = data.tasksByLabel || {};
    const completedRoutes = data.completedRoutes || {};

    let html = `<div style="margin-bottom:12px;"><strong>Маршрут на ${date}</strong></div>`;
 for (const [label, numbers] of Object.entries(labels)) {
      const completed = completedRoutes[label];
      const scannedSet = completed && Array.isArray(completed.scanned) ? new Set(completed.scanned) : null;
      
      html += `<div class="history-item">
        <div class="history-date">${label} (${numbers.length} отгрузок)`;
      
      if (completed) {
        const completedDate = new Date(completed.completedAt).toLocaleString('ru-RU');
        html += ` <span style="color:#2ecc71;font-size:0.85em;">✓ Закрыт ${completedDate}</span>`;
      } else {
        html += ` <span style="color:#95a5a6;font-size:0.85em;">Не закрыт</span>`;
      }
      
      html += `</div><div class="history-labels">`;

      if (scannedSet) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
        numbers.forEach(num => {
          const wasScanned = scannedSet.has(num);
          const statusClass = wasScanned ? 'status-shipped' : 'status-other';
          const statusText = wasScanned ? '✓' : '—';
          html += `<div style="display:inline-flex;align-items:center;background:#f9f9f9;padding:4px 8px;border-radius:6px;">
            <span>№${num}</span>
            <span class="status-badge ${statusClass}">${statusText}</span>
          </div>`;
        });
        html += '</div>';
        
        const scannedCount = numbers.filter(n => scannedSet.has(n)).length;
        html += `<div style="margin-top:8px;font-size:0.9em;color:#555;"><strong>Отсканировано:</strong> ${scannedCount} из ${numbers.length}</div>`;
      } else {
        html += numbers.map(n => `№${n}`).join(", ");
      }

      if (tasksByLabel[label] && tasksByLabel[label].length) {
        html += `<div style="margin-top:8px;font-size:0.9em;color:#555;"><strong>Задания:</strong> ${tasksByLabel[label].join("; ")}</div>`;
      }

      html += `</div></div>`;
    }

    listEl.innerHTML = html;
  } catch (e) {
    listEl.innerHTML = '<div class="hint">Не удалось загрузить маршрут</div>';
  }
}
