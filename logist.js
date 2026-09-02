function logout() {
  localStorage.removeItem("sklad_session");
  localStorage.removeItem("sklad_user");
  document.getElementById("screen-main").style.display = "none";
  document.getElementById("screen-login").style.display = "block";
}

function getSavedAuth() {
  const token = localStorage.getItem("sklad_session");
  return token ? `Bearer ${token}` : null;
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
  if (!login || !pass) { errEl.textContent = "Заполните логин и пароль"; return; }
  const authHeader = "Basic " + btoa(unescape(encodeURIComponent(login + ":" + pass)));
  try {
    const res = await fetch(`${CONFIG.PROXY_URL}/login`, { method: "POST", headers: { Authorization: authHeader } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = data.error || "Не удалось войти"; return; }
    localStorage.setItem("sklad_session", data.token);
    localStorage.setItem("sklad_user", login);
    document.getElementById("screen-login").style.display = "none";
    document.getElementById("screen-main").style.display = "block";
  } catch {
    errEl.textContent = "Нет соединения с сервером";
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
    document.getElementById("send-btn").style.display = "block";
  } catch (e) {
    statusEl.innerHTML = '<span class="error">Не удалось прочитать PDF. Убедитесь, что файл не повреждён.</span>';
  }
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
      body: JSON.stringify({ date, label, numbers: parsedNumbers }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    if (data.ok) {
      const label = document.getElementById("route-label").value;
      resultEl.innerHTML = `<p class="ok-msg">Готово! Маршрут "${label}" на ${date} сохранён, всего в нём: ${data.count} отгрузок (это общее число по всем типам на эту дату). Контролёр может выбрать тип "${label}" и нажать "Загрузить маршрут" в своём приложении.</p>`;
    } else {
      resultEl.innerHTML = `<p class="error">${data.error || "Не удалось отправить маршрут"}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="error">Нет соединения с сервером.</p>';
  }
}
