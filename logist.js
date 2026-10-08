pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedNumbers = [];
let routeTasks = [];
let lastSentRoute = null;

function getSavedAuth() { const token = localStorage.getItem("sklad_token"); return token ? "Bearer " + token : null; }
function logout() { localStorage.removeItem("sklad_token"); localStorage.removeItem("sklad_user"); document.getElementById("screen-login").style.display = "block"; document.getElementById("screen-main").style.display = "none"; }

window.addEventListener("load", function() {
  document.getElementById("route-date").valueAsDate = new Date();
  var historyDateEl = document.getElementById("history-date");
  if (historyDateEl) historyDateEl.valueAsDate = new Date();
  if (getSavedAuth()) { document.getElementById("screen-login").style.display = "none"; document.getElementById("screen-main").style.display = "block"; }
});

async function doLogin() {
  var login = document.getElementById("login-user").value.trim();
  var pass = document.getElementById("login-pass").value;
  var errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!login || !pass) { errEl.textContent = "Заполните логин и пароль"; return; }
  var basicAuth = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));
  try {
    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 10000);
    var res = await fetch(CONFIG.PROXY_URL + "/login", { method: "POST", headers: { "Authorization": basicAuth, "Content-Type": "application/json" }, signal: controller.signal });
    clearTimeout(tid);
    if (res.status === 401) { errEl.textContent = "Неверный логин или пароль"; return; }
    if (res.status === 403) { errEl.textContent = "У вас нет прав логиста"; return; }
    if (!res.ok) { errEl.textContent = "Ошибка сервера (код " + res.status + ")"; return; }
    var data = await res.json();
    if (!data.ok || !data.token) { errEl.textContent = data.error || "Сервер не вернул токен"; return; }
    localStorage.setItem("sklad_token", data.token);
    localStorage.setItem("sklad_user", data.user || login);
    document.getElementById("screen-login").style.display = "none";
    document.getElementById("screen-main").style.display = "block";
  } catch (e) { console.error("Ошибка входа:", e); if (e.name === "AbortError") errEl.textContent = "Превышено время ожидания. Проверьте интернет."; else errEl.textContent = "Нет соединения с сервером. Проверьте PROXY_URL в config.js"; }
}

document.addEventListener("DOMContentLoaded", function() { document.getElementById("pdf-file").addEventListener("change", handleFile); });

async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fileName = file.name ? file.name.replace(/\.[^.]+$/, "").toUpperCase() : "";
  const selectedType = document.getElementById("route-label").value.toUpperCase();
  let detectedType = null;
  if (/^МСК\d/i.test(fileName) || /^MSK\d/i.test(fileName)) detectedType = "МСК";
  else if (/^ТК\d/i.test(fileName) || /^TK\d/i.test(fileName)) detectedType = "ТК";
  else if (/^НАЙМ\d/i.test(fileName) || /^HIRE\d/i.test(fileName) || /^NAIM\d/i.test(fileName)) detectedType = "Найм";
  let warning = null;
  if (!detectedType) warning = 'Файл "' + file.name + '" не соответствует формату имени.\n\nТребуемый формат: МСК30092026.pdf, ТК30.09.26.pdf, Найм300926.pdf\n\nПродолжить загрузку?';
  else if (detectedType !== selectedType) warning = 'Файл "' + file.name + '" относится к типу "' + detectedType + '",\nа выбран тип "' + selectedType + '".\n\nПродолжить загрузку?';
  if (warning) { if (!confirm(warning)) { e.target.value = ""; return; } }
  var statusEl = document.getElementById("parse-status");
  statusEl.textContent = "Читаю файл…";
  document.getElementById("preview-card").style.display = "none";
  document.getElementById("send-btn").style.display = "none";
  document.getElementById("task-btn").style.display = "none";
  document.getElementById("print-btn").style.display = "none";
  document.getElementById("task-preview").textContent = "";
  routeTasks = []; lastSentRoute = null; parsedNumbers = [];
  try {
    var arrayBuffer = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    var fullText = "";
    for (var i = 1; i <= pdf.numPages; i++) { var page = await pdf.getPage(i); var content = await page.getTextContent(); fullText += content.items.map(function(it) { return it.str; }).join(" ") + "\n"; }
    var regex = /(\d{4,7})\s+(?:Да|Нет)\s+\d{2}\.\d{2}\.\d{4}/g;
    var found = new Set(); var m;
    while ((m = regex.exec(fullText)) !== null) found.add(m[1]);
    parsedNumbers = Array.from(found);
    if (!parsedNumbers.length) { statusEl.innerHTML = "Не удалось найти номера отгрузок."; return; }
    statusEl.innerHTML = "Найдено: " + parsedNumbers.length + ". Нажмите \"Отправить маршрут\".";
    document.getElementById("preview-count").textContent = "Отгрузки (" + parsedNumbers.length + "):";
    document.getElementById("preview-chips").innerHTML = parsedNumbers.map(function(n) { return "<span class=\"chip\">" + n + "</span>"; }).join("");
    document.getElementById("preview-card").style.display = "block";
    document.getElementById("task-btn").style.display = "inline-block";
    document.getElementById("send-btn").style.display = "block";
  } catch (e) { statusEl.innerHTML = "Не удалось прочитать PDF."; }
}

function openTaskModal() { document.getElementById("task-input").value = routeTasks.join("\n"); document.getElementById("task-modal").style.display = "flex"; }
function closeTaskModal() { document.getElementById("task-modal").style.display = "none"; }
function saveTasks() { routeTasks = document.getElementById("task-input").value.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean); document.getElementById("task-preview").textContent = routeTasks.length ? "Заданий: " + routeTasks.length : "Нет заданий"; closeTaskModal(); }

async function sendRoute() {
  var date = document.getElementById("route-date").value;
  var label = document.getElementById("route-label").value.trim();
  var resultEl = document.getElementById("send-result");
  if (!parsedNumbers || parsedNumbers.length === 0) { resultEl.innerHTML = "<span class=\"error\">Список пуст.</span>"; return; }
  resultEl.textContent = "Шаг 1/2: Загружаю данные...";
  try {
    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 30000);
    var resDetails = await fetch(CONFIG.PROXY_URL + "/route/details", { method: "POST", headers: { "Authorization": getSavedAuth(), "Content-Type": "application/json" }, body: JSON.stringify({ numbers: parsedNumbers }), signal: controller.signal });
    clearTimeout(tid);
    if (resDetails.status === 401) { logout(); return; }
    if (!resDetails.ok) throw new Error("Ошибка получения данных");
    var detailsData = await resDetails.json();
    var enrichedItems = detailsData.details || [];
    resultEl.textContent = "Шаг 2/2: Сохраняю маршрут...";
    var resRoute = await fetch(CONFIG.PROXY_URL + "/route", { method: "POST", headers: { "Authorization": getSavedAuth(), "Content-Type": "application/json" }, body: JSON.stringify({ date: date, label: label, numbers: parsedNumbers, tasks: routeTasks }) });
    if (resRoute.status === 401) { logout(); return; }
    var routeData = await resRoute.json();
    if (routeData.ok) { lastSentRoute = { date: date, label: label, items: enrichedItems, tasks: routeTasks.slice() }; document.getElementById("print-btn").style.display = "inline-block"; resultEl.innerHTML = "<span style=\"color:green;\">Готово! Отгрузок: " + routeData.count + ".</span>"; }
    else { resultEl.innerHTML = "<span class=\"error\">" + (routeData.error || "Ошибка") + "</span>"; }
  } catch (e) { console.error(e); if (e.name === "AbortError") resultEl.innerHTML = "<span class=\"error\">Таймаут (30 сек). Проверьте интернет.</span>"; else resultEl.innerHTML = "<span class=\"error\">Ошибка соединения.</span>"; }
}

function printRoute() {
if (!lastSentRoute) return;

var esc = function(v) {
return String(v == null ? "" : v).replace(/[&<>"']/g, function(c) {
return {
"&": "&",
"<": "<",
">": ">",
'"': """,
"'": "'"
}[c];
});
};

var r = lastSentRoute;
var groups = {};

// Приводим название ТК к единому виду для группировки и сортировки.
var knownTCs = [
"Деловые Линии",
"Байкал",
"ПЭК",
"Новая Линия",
"Мэджик Транс",
"Главтрасса",
"НТК",
"РТС",
"Рейл континент",
"Авангард",
"Витэка",
"Транзит",
"Сдэк"
];

function normalizeTC(value) {
var raw = String(value || "")
.replace(/^(?:\s*(?:ТК|Т.К.|ООО)\s*)+/i, "")
.replace(/\s+/g, " ")
.trim();

```
if (!raw) return "Без ТК";

var lower = raw.toLocaleLowerCase("ru-RU");

// Сначала ищем полное название или его начало.
var matches = knownTCs.filter(function(name) {
  var n = name.toLocaleLowerCase("ru-RU");
  return n === lower || n.indexOf(lower) === 0 ||
    lower.indexOf(n) === 0;
});

// Если найдено однозначное совпадение, используем полное имя.
if (matches.length === 1) return matches[0];

// Дополнительно ищем известное название внутри текста.
matches = knownTCs.filter(function(name) {
  return lower.indexOf(name.toLocaleLowerCase("ru-RU")) !== -1;
});

if (matches.length === 1) return matches[0];

return raw;
```

}

r.items.forEach(function(d) {
var tc = normalizeTC(d.tc);
if (!groups[tc]) groups[tc] = [];
groups[tc].push(d);
});

var sortedTCs = Object.keys(groups).sort(function(a, b) {
return a.localeCompare(b, "ru");
});

var itemsHtml = "";

sortedTCs.forEach(function(tc) {
// Сортируем отгрузки по клиенту, затем по номеру.
groups[tc].sort(function(a, b) {
var clientA = String(a.clientName || a.agentName || "").toLocaleLowerCase("ru-RU");
var clientB = String(b.clientName || b.agentName || "").toLocaleLowerCase("ru-RU");

```
  var cmp = clientA.localeCompare(clientB, "ru");
  if (cmp !== 0) return cmp;

  return String(a.number || "").localeCompare(String(b.number || ""), "ru", {
    numeric: true
  });
});

itemsHtml +=
  "<h2>" + esc(tc) + " (" + groups[tc].length + " отгрузок)</h2>";

itemsHtml +=
  "<table><thead><tr>" +
  "<th style='width:90px'>Отгрузка</th>" +
  "<th style='width:60px'>Мест</th>" +
  "<th style='width:220px'>Клиент</th>" +
  "<th>Описание</th>" +
  "</tr></thead><tbody>";

groups[tc].forEach(function(d) {
  var client = d.clientName || d.agentName || "";
  var desc = d.description || "";

  itemsHtml +=
    "<tr>" +
    "<td>№ " + esc(d.number) + "</td>" +
    "<td style='text-align:center'>" +
      esc(d.places == null ? "—" : d.places) +
    "</td>" +
    "<td>" + esc(client || "—") + "</td>" +
    "<td>" + esc(desc || "—") + "</td>" +
    "</tr>";
});

itemsHtml += "</tbody></table>";
```

});

var taskList = Array.isArray(r.tasks) ? r.tasks : [];
var tasks = taskList.length
? taskList.map(function(t) {
return "<li>" + esc(t) + "</li>";
}).join("")
: "<li>Нет заданий</li>";

var w = window.open("", "_blank");
if (!w) {
alert("Разрешите всплывающие окна.");
return;
}

w.document.write(
"<!DOCTYPE html><html><head><meta charset='utf-8'>" +
"<title>Маршрут " + esc(r.label) + "</title>" +
"<style>" +
"@page { size: A4 portrait; margin: 10mm; }" +
"body { font-family: Arial, sans-serif; font-size: 11px; }" +
"h1 { font-size: 16px; margin: 0 0 4px; }" +
".meta { color: #555; margin-bottom: 12px; font-size: 12px; }" +
"h2 { font-size: 13px; margin: 14px 0 6px; background: #e8f4f8; padding: 7px; }" +
"table { border-collapse: collapse; width: 100%; margin-bottom: 16px; table-layout: fixed; }" +
"th, td { border: 1px solid #999; padding: 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }" +
"th { background: #f0f0f0; }" +
"ul { margin: 0; padding-left: 20px; }" +
"@media print { tr { page-break-inside: avoid; } }" +
"</style></head><body>" +
"<h1>Маршрут: " + esc(r.label) + "</h1>" +
"<div class='meta'>Дата: " + esc(r.date) + "</div>" +
itemsHtml +
"<h2>Дополнительные задания</h2><ul>" + tasks + "</ul>" +
"<script>window.onload=function(){window.print();}</script>" +
"</body></html>"
);

w.document.close();
}


async function showHistoryForDate() {
  var date = document.getElementById("history-date").value;
  var listEl = document.getElementById("history-list");
  if (!date) { listEl.innerHTML = "<div class=\"hint\">Выберите дату</div>"; return; }
  listEl.innerHTML = "<div class=\"hint\">Загружаю…</div>";
  try {
    var res = await fetch(CONFIG.PROXY_URL + "/route?date=" + date, { headers: { "Authorization": getSavedAuth() } });
    if (res.status === 401) { logout(); return; }
    var data = await res.json();
    if (!data.found) { listEl.innerHTML = "<div class=\"hint\">На " + date + " маршрутов нет</div>"; return; }
    var labels = {};
    (data.items || []).forEach(function(it) { if (!labels[it.label]) labels[it.label] = []; labels[it.label].push(it.number); });
    var tasksByLabel = data.tasksByLabel || {};
    var completedRoutes = data.completedRoutes || {};
    var html = "<div style=\"margin-bottom:12px;\"><strong>Маршрут на " + date + "</strong></div>";
    for (var label in labels) {
      var numbers = labels[label];
      var completed = completedRoutes[label];
      var scannedSet = completed && Array.isArray(completed.scanned) ? new Set(completed.scanned) : null;
      html += "<div class=\"history-item\"><div class=\"history-date\">" + label + " (" + numbers.length + " отгрузок)";
      if (completed) html += " <span style=\"color:#2ecc71;font-size:0.85em;\">Закрыт " + new Date(completed.completedAt).toLocaleString("ru-RU") + "</span>";
      else html += " <span style=\"color:#95a5a6;font-size:0.85em;\">Не закрыт</span>";
      html += "</div><div class=\"history-labels\">";
      if (scannedSet) {
        html += "<div style=\"display:flex;flex-wrap:wrap;gap:6px;\">";
        numbers.forEach(function(num) { var wasScanned = scannedSet.has(num); html += "<div style=\"display:inline-flex;align-items:center;background:#f9f9f9;padding:4px 8px;border-radius:6px;\"><span>№" + num + "</span><span class=\"status-badge " + (wasScanned ? "status-shipped" : "status-other") + "\">" + (wasScanned ? "✓" : "—") + "</span></div>"; });
        html += "</div>";
      } else { html += numbers.map(function(n) { return "№" + n; }).join(", "); }
      if (tasksByLabel[label] && tasksByLabel[label].length) { html += "<div style=\"margin-top:8px;font-size:0.9em;color:#555;\"><strong>Задания:</strong> " + tasksByLabel[label].join("; ") + "</div>"; }
      html += "</div></div>";
    }
    listEl.innerHTML = html;
  } catch (e) { listEl.innerHTML = "<div class=\"hint\">Не удалось загрузить</div>"; }
}
