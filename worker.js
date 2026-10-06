const API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const STATUS_READY_NAME = "Собрано";
const STATUS_SHIPPED_NAME = "Отгружено";
const PLACES_FIELD_NAME = "Количество мест";
const BITRIX_CHAT_ID = 11359;
const BITRIX_DIALOG_ID = `chat${BITRIX_CHAT_ID}`;
const ALLOWED_ORIGIN = "https://manlyandy.github.io";
const SESSION_TTL = 28800;
const ROUTE_TTL = 15552000;

const ALLOWED_MS_LOGINS = new Set([
  "kovalkov@boss191", "harunin@boss191", "grishaev@boss191", "absaluttinova@boss191"
].map(v => v.trim().toLowerCase()).filter(Boolean));

const ALLOWED_ROUTE_LOGINS = new Set([
  "kovalkov@boss191", "harunin@boss191", "grishaev@boss191", "absaluttinova@boss191"
].map(v => v.trim().toLowerCase()).filter(Boolean));

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function json(data, status) {
  status = status || 200;
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders() }
  });
}

function getBasicUsername(auth) {
  try {
    if (!auth || auth.indexOf("Basic ") !== 0) return "";
    const raw = atob(auth.slice(6));
    const colon = raw.indexOf(":");
    return colon >= 0 ? raw.slice(0, colon).trim().toLowerCase() : "";
  } catch (e) { return ""; }
}

function isAllowedLogin(username) {
  return ALLOWED_MS_LOGINS.has(String(username || "").trim().toLowerCase());
}

function isAllowedRouteLogin(username) {
  return ALLOWED_ROUTE_LOGINS.has(String(username || "").trim().toLowerCase());
}

async function checkAuth(auth) {
  if (!auth || auth.indexOf("Basic ") !== 0) return 401;
  try {
    const controller = new AbortController();
    const tid = setTimeout(function() { controller.abort(); }, 5000);
    const res = await fetch(API_BASE + "/context/employee", {
      headers: { "Authorization": auth, "Accept-Encoding": "gzip" },
      signal: controller.signal
    });
    clearTimeout(tid);
    return res.status;
  } catch (e) { return 0; }
}

async function verifyAuth(auth) {
  const status = await checkAuth(auth);
  return status >= 200 && status < 300;
}

function buildAuthVariants(auth) {
  try {
    const raw = atob(auth.slice(6));
    const colon = raw.indexOf(":");
    if (colon < 0) return [auth];
    const user = raw.slice(0, colon).trim();
    const pass = raw.slice(colon + 1);
    const v1 = "Basic " + btoa(user + ":" + pass);
    const v2 = "Basic " + btoa(user + ":" + pass.trim());
    return v1 === v2 ? [v1] : [v1, v2];
  } catch (e) { return [auth]; }
}

async function createSession(auth, env) {
  if (!env.ROUTES) return null;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, function(b) { return b.toString(16).padStart(2, "0"); }).join("");
  await env.ROUTES.put("session:" + token, auth, { expirationTtl: SESSION_TTL });
  return token;
}

async function getSessionAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (header.indexOf("Bearer ") !== 0 || !env.ROUTES) return null;
  const token = header.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return await env.ROUTES.get("session:" + token);
}

function unauthorized() { return json({ error: "Сессия недействительна" }, 401); }

async function handleLogin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.indexOf("Basic ") !== 0) return unauthorized();
  const username = getBasicUsername(auth);
  if (!isAllowedLogin(username)) return json({ error: "Доступ запрещён" }, 403);

  let goodAuth = null;
  let lastStatus = 401;
  const variants = buildAuthVariants(auth);
  for (let i = 0; i < variants.length; i++) {
    lastStatus = await checkAuth(variants[i]);
    if (lastStatus >= 200 && lastStatus < 300) { goodAuth = variants[i]; break; }
    if (lastStatus !== 401) break;
  }
  if (!goodAuth) {
    if (lastStatus === 401) return json({ error: "Неверный логин или пароль" }, 401);
    return json({ error: "МойСклад не ответил (код " + lastStatus + ")" }, 502);
  }
  const token = await createSession(goodAuth, env);
  if (!token) return json({ error: "Хранилище не настроено" }, 500);
  return json({ ok: true, token: token, expiresIn: SESSION_TTL, user: username });
}

function extractPlaces(row) {
  const attrs = Array.isArray(row.attributes) ? row.attributes : [];
  let attr = null;
  for (let i = 0; i < attrs.length; i++) {
    const n = String(attrs[i].name || "").trim().toLowerCase();
    if (n === PLACES_FIELD_NAME.toLowerCase()) { attr = attrs[i]; break; }
  }
  if (!attr) {
    for (let i = 0; i < attrs.length; i++) {
      if (/количеств.*мест/i.test(String(attrs[i].name || ""))) { attr = attrs[i]; break; }
    }
  }
  if (!attr) return null;
  const value = attr.value;
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    if (value.value !== undefined) return value.value;
    if (value.name !== undefined) return value.name;
  }
  return value;
}

const KNOWN_TC_NAMES = [
  "Деловые Линии", "Байкал", "ПЭК", "Новая Линия", "Мэджик Транс",
  "Главтрасса", "НТК", "РТС", "Рейл континент", "Авангард",
  "Витэка", "Транзит", "Сдэк"
];
const TC_ORDER = new Map(KNOWN_TC_NAMES.map(function(name, i) { return [name.toLowerCase(), i]; }));

function normalizeText(s) {
  return String(s || "")
    .replace(/[«»“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTCFromDescription(desc) {
  const text = normalizeText(desc);
  if (!text) return "";
  // Триггер — именно название из справочника. "ТК", "ООО" и прочие приставки не обязательны.
  for (let i = 0; i < KNOWN_TC_NAMES.length; i++) {
    const name = KNOWN_TC_NAMES[i];
    const re = new RegExp("(?:^|[^А-Яа-яЁёA-Za-z])" + escapeRegExp(name) + "(?:$|[^А-Яа-яЁёA-Za-z])", "i");
    if (re.test(text)) return name;
  }
  return "";
}

function cleanClientCandidate(value) {
  let s = normalizeText(value);
  if (!s) return "";
  // Убираем служебные подписи, но не трогаем само имя клиента.
  s = s.replace(/^\s*(?:клиент|покупатель|получатель|заказчик|имя|название)\s*[:\-]\s*/i, "").trim();
  for (let i = 0; i < KNOWN_TC_NAMES.length; i++) {
    const name = KNOWN_TC_NAMES[i];
    const re = new RegExp("(?:^|\s)(?:ТК\s+|ООО\s+)?" + escapeRegExp(name) + "(?:$|\s|[,;])", "ig");
    s = s.replace(re, " ");
  }
  s = s.replace(/\s+/g, " ").replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "").trim();
  return s;
}

function extractClientFromDescription(desc) {
  const raw = String(desc || "").replace(/\r/g, "");
  if (!raw.trim()) return "";
  const lines = raw.split(/\n/).map(function(x) { return x.trim(); }).filter(Boolean);

  // В первую очередь ищем явно подписанное поле клиента.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:клиент|покупатель|получатель|заказчик|имя|название)\s*[:\-]\s*(.+)$/i);
    if (m) {
      const v = cleanClientCandidate(m[1]);
      if (v) return v;
    }
  }

  // Если подписи нет, используем первую содержательную строку текстового поля,
  // убрав из неё название ТК. Это позволяет объединять одинаковые имена клиентов.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:тк|транспортная\s+компания|ооо)\s*[:\-]?\s*$/i.test(line)) continue;
    const v = cleanClientCandidate(line);
    if (v && !/^тк\b/i.test(v)) return v;
  }
  return "";
}


async function handleFind(url, auth) {
  const code = (url.searchParams.get("code") || "").trim();
  if (!code) return json({ error: "Не передан номер" }, 400);
  const filter = encodeURIComponent("name=" + code);
  const res = await fetch(API_BASE + "/entity/demand?filter=" + filter + "&expand=agent,state", {
    headers: { "Authorization": auth },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (res.status === 401) return unauthorized();
  if (!res.ok) return json({ error: "Ошибка МойСклад" }, 502);
  const data = await res.json();
  const row = data.rows && data.rows[0];
  if (!row) return json({ found: false });

  const detailRes = await fetch(API_BASE + "/entity/demand/" + row.id + "?expand=agent,state", {
    headers: { "Authorization": auth }
  });
  if (!detailRes.ok) return json({ error: "Не удалось получить данные" }, 502);
  const detail = await detailRes.json();
  const stateName = detail.state ? detail.state.name : null;
  const places = extractPlaces(detail);

  return json({
    found: true,
    id: detail.id,
    name: detail.name,
    agentName: detail.agent ? detail.agent.name : "—",
    sum: detail.sum ? (detail.sum / 100).toFixed(2) : "—",
    positionsCount: (detail.positions && detail.positions.meta) ? detail.positions.meta.size : "—",
    places: places,
    description: detail.description || "",
    tc: extractTCFromDescription(detail.description),
    clientName: extractClientFromDescription(detail.description),
    stateName: stateName,
    ready: stateName === STATUS_READY_NAME,
    alreadyShipped: stateName === STATUS_SHIPPED_NAME
  });
}

async function handleRouteDetails(request, auth) {
  const body = await request.json();
  const numbers = Array.isArray(body.numbers) ? body.numbers.map(String).filter(Boolean).slice(0, 100) : [];
  if (!numbers.length) return json({ ok: true, details: [] });

  const details = [];
  for (let i = 0; i < numbers.length; i += 10) {
    const batch = numbers.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(async function(num) {
      try {
        const filter = encodeURIComponent("name=" + num);
        const res = await fetch(API_BASE + "/entity/demand?filter=" + filter + "&expand=agent,state", {
          headers: { "Authorization": auth },
          cf: { cacheTtl: 0 }
        });
        if (!res.ok) return { number: num, places: null, description: "", tc: "", agentName: "" };
        const data = await res.json();
        const row = data.rows && data.rows[0];
        if (!row) return { number: num, places: null, description: "", tc: "", agentName: "" };

        const detailRes = await fetch(API_BASE + "/entity/demand/" + row.id + "?expand=agent,state", {
          headers: { "Authorization": auth }
        });
        if (!detailRes.ok) return { number: num, places: null, description: "", tc: "", agentName: "" };
        const detail = await detailRes.json();

        return {
          number: num,
          places: extractPlaces(detail),
          description: detail.description || "",
          tc: extractTCFromDescription(detail.description),
          clientName: extractClientFromDescription(detail.description),
          agentName: detail.agent && detail.agent.name ? detail.agent.name : ""
        };
      } catch (e) { return { number: num, places: null, description: "", tc: "" }; }
    }));
    details.push.apply(details, batchResults);
    if (i + 10 < numbers.length) await new Promise(function(r) { setTimeout(r, 200); });
  }
  return json({ ok: true, details: details });
}

async function handleShip(request, auth) {
  const body = await request.json();
  const id = body.id;
  if (!id) return json({ error: "Не передан id" }, 400);
  const demandRes = await fetch(API_BASE + "/entity/demand/" + encodeURIComponent(id) + "?expand=state", {
    headers: { "Authorization": auth },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (demandRes.status === 401) return unauthorized();
  if (!demandRes.ok) return json({ error: "Не удалось проверить" }, 502);
  const demand = await demandRes.json();
  const currentState = demand.state ? demand.state.name : null;
  if (currentState !== STATUS_READY_NAME) {
    return json({ ok: false, error: "Статус: " + (currentState || "—") }, 409);
  }
  const metaRes = await fetch(API_BASE + "/entity/demand/metadata", { headers: { "Authorization": auth } });
  if (!metaRes.ok) return json({ error: "Не удалось получить метаданные" }, 502);
  const meta = await metaRes.json();
  const states = meta.states || (meta.states && meta.states.rows) || [];
  let shippedState = null;
  for (let i = 0; i < states.length; i++) {
    if (states[i].name === STATUS_SHIPPED_NAME) { shippedState = states[i]; break; }
  }
  if (!shippedState) return json({ error: "Статус не найден" }, 500);
  const putRes = await fetch(API_BASE + "/entity/demand/" + encodeURIComponent(id), {
    method: "PUT",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify({ state: { meta: shippedState.meta } })
  });
  if (putRes.status === 401) return unauthorized();
  if (!putRes.ok) return json({ error: "Не удалось сменить статус" }, 502);
  return json({ ok: true });
}

async function handleFinish(request, auth) {
  const body = await request.json();
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(Boolean))].slice(0, 100) : [];
  if (!ids.length) return json({ error: "Список пуст" }, 400);
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const demandRes = await fetch(API_BASE + "/entity/demand/" + encodeURIComponent(id) + "?expand=state", {
        headers: { "Authorization": auth },
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      if (demandRes.status === 401) return unauthorized();
      if (!demandRes.ok) { results.push({ id: id, ok: false, error: "Ошибка" }); continue; }
      const demand = await demandRes.json();
      const currentState = demand.state ? demand.state.name : null;
      if (currentState === STATUS_SHIPPED_NAME) { results.push({ id: id, ok: true, alreadyShipped: true }); continue; }
      if (currentState !== STATUS_READY_NAME) { results.push({ id: id, ok: false, error: "Статус: " + currentState }); continue; }
      const metaRes = await fetch(API_BASE + "/entity/demand/metadata", { headers: { "Authorization": auth } });
      if (!metaRes.ok) { results.push({ id: id, ok: false, error: "Ошибка метаданных" }); continue; }
      const meta = await metaRes.json();
      const states = meta.states || (meta.states && meta.states.rows) || [];
      let shippedState = null;
      for (let j = 0; j < states.length; j++) {
        if (states[j].name === STATUS_SHIPPED_NAME) { shippedState = states[j]; break; }
      }
      if (!shippedState) { results.push({ id: id, ok: false, error: "Статус не найден" }); continue; }
      const putRes = await fetch(API_BASE + "/entity/demand/" + encodeURIComponent(id), {
        method: "PUT",
        headers: { "Authorization": auth, "Content-Type": "application/json" },
        body: JSON.stringify({ state: { meta: shippedState.meta } })
      });
      if (putRes.status === 401) return unauthorized();
      results.push({ id: id, ok: putRes.ok });
    } catch (e) { results.push({ id: id, ok: false, error: "Ошибка" }); }
  }
  return json({ ok: true, results: results });
}

function routeKey(date) { return "route:" + date; }

async function handleRouteUpload(request, auth, env) {
  if (!env.ROUTES) return json({ error: "Хранилище не подключено" }, 500);
  if (!(await verifyAuth(auth))) return unauthorized();
  const body = await request.json();
  const date = (body.date || "").trim();
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers.map(function(x) { return String(x).trim(); }).filter(Boolean))].slice(0, 1000) : [];
  const label = (body.label || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Неверная дата" }, 400);
  if (!numbers.length) return json({ error: "Список пуст" }, 400);
  if (!label || label.length > 100) return json({ error: "Неверное название" }, 400);
  const key = routeKey(date);
  const existing = await env.ROUTES.get(key, { type: "json" });
  const items = Array.isArray(existing && existing.items) ? existing.items : [];
  const filtered = items.filter(function(item) { return item.label !== label; });
  for (let i = 0; i < numbers.length; i++) {
    filtered.push({ number: numbers[i], label: label });
  }
  await env.ROUTES.put(key, JSON.stringify({
    date: date,
    items: filtered,
    tasksByLabel: (existing && existing.tasksByLabel) || {},
    completedRoutes: (existing && existing.completedRoutes) || {}
  }), { expirationTtl: ROUTE_TTL });
  return json({ ok: true, count: filtered.length });
}

async function handleRouteGet(url, auth, env) {
  if (!env.ROUTES) return json({ error: "Хранилище не подключено" }, 500);
  const date = (url.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Неверная дата" }, 400);
  if (!(await verifyAuth(auth))) return unauthorized();
  const data = await env.ROUTES.get(routeKey(date), { type: "json" });
  return json(data ? { found: true, date: data.date, items: data.items, tasksByLabel: data.tasksByLabel, completedRoutes: data.completedRoutes } : { found: false, date: date });
}

async function handleRouteComplete(request, auth, env) {
  if (!env.ROUTES) return json({ error: "Хранилище не подключено" }, 500);
  if (!(await verifyAuth(auth))) return unauthorized();
  const body = await request.json();
  const date = String(body.date || "").trim();
  const label = String(body.label || "").trim();
  const scanned = Array.isArray(body.scanned) ? body.scanned.map(String).filter(Boolean) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !label) return json({ error: "Неверные данные" }, 400);
  const key = routeKey(date);
  const data = await env.ROUTES.get(key, { type: "json" });
  if (!data || !Array.isArray(data.items)) return json({ error: "Маршрут не найден" }, 404);
  const completedRoutes = (data.completedRoutes && typeof data.completedRoutes === "object") ? data.completedRoutes : {};
  completedRoutes[label] = { completedAt: new Date().toISOString(), scanned: scanned };
  await env.ROUTES.put(key, JSON.stringify({ date: data.date, items: data.items, tasksByLabel: data.tasksByLabel, completedRoutes: completedRoutes }), { expirationTtl: ROUTE_TTL });
  return json({ ok: true, date: date, label: label, completedAt: completedRoutes[label].completedAt });
}

const PHOTO_MAX_PAGES = 20;
const PHOTO_CACHE_TTL = 21600; // 6 часов — быстрый кэш результата поиска
const PHOTO_FILE_CACHE_TTL = 2592000; // 30 дней — вспомогательная ссылка на файл
const PHOTO_TIME_BUDGET_MS = 20000;
const PHOTO_WARM_MAX_PAGES = 10;
const PHOTO_WARM_TIME_BUDGET_MS = 9000;
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function collectFileIds(m) {
  const ids = [];
  const p = m.params || m.PARAMS || {};
  [p.FILE_ID, p.FILES, m.files, m.FILES, m.file_id].forEach(function(v) {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach(function(x) { ids.push(String(x && typeof x === "object" ? x.id : x)); });
    else if (typeof v === "object") Object.keys(v).forEach(function(k) { ids.push(String(v[k] && v[k].id != null ? v[k].id : k)); });
    else ids.push(String(v));
  });
  return ids.filter(function(x) { return x && x !== "undefined" && x !== "null"; });
}

function splitResult(data) {
  const res = (data && data.result) || {};
  const messages = Array.isArray(res.messages) ? res.messages : Object.values(res.messages || {});
  const filesArr = Array.isArray(res.files) ? res.files : Object.values(res.files || {});
  const filesById = {};
  filesArr.forEach(function(f) { if (f && f.id != null) filesById[String(f.id)] = f; });
  return { messages: messages, filesById: filesById };
}

function msgId(m) { return Number(m.id || m.ID); }

function photoIndexKey(number) { return "pi2:" + String(number).trim(); }

// Пытаемся достать именно данные файла из результата im.v2.File.upload.
// API может вернуть объект или массив, поэтому разбираем несколько известных форматов,
// но не принимаем произвольный message/chat id за id файла.
function extractUploadedFiles(result, expectedNames) {
  const names = new Set((expectedNames || []).map(function(x) { return String(x); }));
  const out = new Map();
  const seen = new Set();

  function visit(v, depth) {
    if (depth > 6 || v == null) return;
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      v.forEach(function(x) { visit(x, depth + 1); });
      return;
    }

    const id = v.id != null ? v.id : (v.ID != null ? v.ID : (v.fileId != null ? v.fileId : v.FILE_ID));
    const name = v.name != null ? String(v.name) : (v.NAME != null ? String(v.NAME) : "");
    const url = v.urlDownload || v.urlShow || v.DOWNLOAD_URL || v.downloadUrl || "";
    const looksLikeFile = id != null && (/^\d+$/.test(String(id))) && (
      names.has(name) || !!url || v.file != null || v.FILE != null || v.size != null || v.SIZE != null ||
      v.contentType != null || v.CONTENT_TYPE != null
    );
    if (looksLikeFile) {
      const sid = String(id);
      if (!out.has(sid)) out.set(sid, { id: sid, name: name || "photo-" + sid, url: url || "" });
    }

    Object.keys(v).forEach(function(k) { visit(v[k], depth + 1); });
  }

  visit(result, 0);
  return Array.from(out.values());
}

async function readPhotoIndex(env, number) {
  if (!env.ROUTES) return null;
  try {
    const data = await env.ROUTES.get(photoIndexKey(number), { type: "json" });
    if (data && Array.isArray(data.photos) && data.photos.length) {
      const photos = data.photos.filter(function(p) {
        return p && /^\d+$/.test(String(p.id || ""));
      }).map(function(p) {
        return { id: String(p.id), name: p.name || ("photo-" + p.id), url: p.url || "" };
      });
      if (photos.length && photos.every(function(p) { return !!p.url; })) {
        return { number: String(number), photos: photos, updatedAt: data.updatedAt || "" };
      }
      // Старый индекс без URL считаем неполным: handlePhoto заново найдёт
      // вложения чата и получит настоящий urlDownload/urlShow.
    }
  } catch (e) { /* индекс недоступен */ }
  return null;
}

async function writePhotoIndex(env, number, photos) {
  if (!env.ROUTES || !Array.isArray(photos) || !photos.length) return;
  const clean = [];
  const seen = new Set();
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i] || {};
    const id = String(p.id || "");
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    clean.push({ id: id, name: p.name || ("photo-" + id), url: p.url || "" });
  }
  if (!clean.length) return;
  await env.ROUTES.put(photoIndexKey(number), JSON.stringify({ number: String(number), photos: clean, updatedAt: new Date().toISOString() }));
}

// Разбор пачки сообщений: ищем файлы, подпись которых относится к нужной отгрузке
function processMessages(messages, filesById, ctx) {
  let minId = Infinity;
  let fresh = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const mid = msgId(m);
    if (mid < minId) minId = mid;
    if (ctx.seen.has(mid)) continue;
    ctx.seen.add(mid);
    fresh++;
    const dbg = ctx.dbg;
    dbg.scanned++;
    const text = String(m.text || m.message || m.MESSAGE || "").replace(/\u00a0/g, " ");
    const ids = collectFileIds(m);
    if (ids.length) dbg.withFiles++;
    const textOk = ctx.textRe.test(text);
    const bareNumberOk = new RegExp("^\\s*" + escapeRegExp(ctx.number) + "\\s*$").test(text);
    if (textOk || bareNumberOk) dbg.withText++;
    if ((textOk || bareNumberOk) && !ids.length && ctx.noFile.indexOf(mid) < 0) ctx.noFile.push(mid);
    if (!ids.length) continue;
    for (let j = 0; j < ids.length; j++) {
      const fid = ids[j];
      // В старых ответах Bitrix некоторые числовые ID относятся к сообщению/вложению,
      // а не к Disk-файлу. Принимаем ID только если он подтверждён объектом files.
      const f = filesById[fid];
      if (!f) continue;
      const nameOk = ctx.nameRe.test(String(f.name || ""));
      const hasFileMeta = f.id != null && (f.urlDownload || f.urlShow || f.downloadUrl || f.size != null || f.contentType || f.name);
      if ((textOk || nameOk) && hasFileMeta && !ctx.found.has(fid)) {
        ctx.found.set(fid, { id: fid, name: f.name || ("photo-" + fid), url: f.urlDownload || f.urlShow || f.downloadUrl || "", mid: mid });
      }
    }
  }
  return { minId: minId, fresh: fresh };
}

async function findPhotoFiles(webhook, number, dbg, quick, warm) {
  const esc = escapeRegExp(number);
  const ctx = {
    textRe: new RegExp("отгрузк[а-я]*\\s*(?:№|#|no\\.?|n)?\\s*" + esc + "(?!\\d)", "i"),
    nameRe: new RegExp("order-" + esc + "(?!\\d)", "i"),
    found: new Map(), seen: new Set(), noFile: [], dbg: dbg, number: String(number)
  };
  const t0 = Date.now();
  dbg.scanned = 0; dbg.withFiles = 0; dbg.withText = 0; dbg.steps = [];

  // 1) Поиск по тексту на стороне Битрикс — не зависит от глубины истории чата
  // Один основной поиск по номеру покрывает оба исторических формата:
  // «Отгрузка №29055 ...» и просто «28470».
  // Дополнительные варианты запускаем только если основной поиск не дал фото.
  const queries = [String(number), "Отгрузка №" + number];
  for (let q = 0; q < queries.length && !ctx.found.size; q++) {
    try {
      const data = await bitrixCall(webhook, "im.dialog.messages.search", {
        CHAT_ID: BITRIX_CHAT_ID, SEARCH_MESSAGE: queries[q], ORDER: { ID: "DESC" }, LIMIT: 200
      });
      const r = splitResult(data);
      processMessages(r.messages, r.filesById, ctx);
      dbg.steps.push("поиск «" + queries[q] + "»: " + r.messages.length + " сообщ., найдено фото: " + ctx.found.size);
    } catch (e) {
      dbg.steps.push("поиск «" + queries[q] + "»: ошибка " + String((e && e.message) || e).slice(0, 80));
    }
  }

  // сообщения с нужной подписью, но без файлов в выдаче поиска: достаём их отдельно
  if (!ctx.found.size && ctx.noFile.length) {
    const ids = ctx.noFile.slice(0, 8);
    const results = await Promise.all(ids.map(async function(mid) {
      try {
        return await bitrixCall(webhook, "im.dialog.messages.get", { DIALOG_ID: BITRIX_DIALOG_ID, LAST_ID: mid + 1, LIMIT: 3 });
      } catch (e) { return null; }
    }));
    for (let k = 0; k < results.length; k++) {
      const data = results[k];
      if (!data) continue;
      const r = splitResult(data);
      const only = r.messages.filter(function(m) { return msgId(m) === ids[k]; });
      ctx.seen.delete(ids[k]);
      processMessages(only, r.filesById, ctx);
    }
    dbg.steps.push("уточнено сообщений без файлов: " + ids.length + ", найдено фото: " + ctx.found.size);
  }

  // 2) Запасной путь: постраничный просмотр истории чата.
  // Для фонового прогрева тоже разрешён, но с меньшим бюджетом: он не блокирует интерфейс,
  // а результат сохраняется в постоянный индекс для следующего открытия.
  if (!ctx.found.size && (!quick || warm)) {
    const maxPages = warm ? PHOTO_WARM_MAX_PAGES : PHOTO_MAX_PAGES;
    const timeBudget = warm ? PHOTO_WARM_TIME_BUDGET_MS : PHOTO_TIME_BUDGET_MS;
    let lastId = 0;
    let mode = "LAST_ID";
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() - t0 > timeBudget) { dbg.steps.push("история: остановил по времени"); break; }
      if (page) await sleep(450);
      const payload = { DIALOG_ID: BITRIX_DIALOG_ID, LIMIT: 50 };
      if (lastId) payload[mode] = lastId;
      const data = await bitrixCall(webhook, "im.dialog.messages.get", payload);
      const r = splitResult(data);
      if (!r.messages.length) { dbg.steps.push("история: пусто на странице " + (page + 1)); break; }
      let p = processMessages(r.messages, r.filesById, ctx);
      if (!p.fresh && mode === "LAST_ID" && lastId) {
        // LAST_ID не двигает историю — пробуем FIRST_ID
        const alt = { DIALOG_ID: BITRIX_DIALOG_ID, LIMIT: 50, FIRST_ID: lastId };
        const data2 = await bitrixCall(webhook, "im.dialog.messages.get", alt);
        const r2 = splitResult(data2);
        const p2 = processMessages(r2.messages, r2.filesById, ctx);
        if (p2.fresh) { mode = "FIRST_ID"; p = p2; dbg.steps.push("история: переключился на FIRST_ID"); }
        else { dbg.steps.push("история: страница " + (page + 1) + " не даёт новых сообщений"); break; }
      }
      pages++;
      if (!isFinite(p.minId) || p.minId === lastId) { dbg.steps.push("история: конец на странице " + (page + 1)); break; }
      lastId = p.minId;
      if (ctx.found.size && !p.fresh) break;
    }
    dbg.steps.push("история: страниц просмотрено " + pages);
  }

  dbg.ms = Date.now() - t0;
  dbg.summary = dbg.steps.join(" | ") + " | " + Math.round(dbg.ms / 100) / 10 + " c";
  return Array.from(ctx.found.values()).sort(function(a, b) { return a.mid - b.mid; });
}

async function handlePhoto(url, auth, env) {
  const number = (url.searchParams.get("number") || "").trim();
  if (!number) return json({ error: "Не передан номер" }, 400);
  if (!env.BITRIX_WEBHOOK_URL) return json({ ok: false, error: "Bitrix не настроен", photos: [] }, 500);
  const quick = url.searchParams.get("quick") === "1";
  const warm = url.searchParams.get("warm") === "1";
  const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");
  const cacheKey = "pl2:" + number;
  // Постоянный индекс позволяет старой отгрузке открываться без повторного поиска по истории чата.
  const indexed = await readPhotoIndex(env, number);
  if (indexed) {
    if (env.ROUTES) {
      await Promise.all(indexed.photos.map(function(f) {
        return env.ROUTES.put("pf2:" + f.id, JSON.stringify({ url: f.url }), { expirationTtl: PHOTO_FILE_CACHE_TTL });
      }));
    }
    return json({ ok: true, number: number, photos: indexed.photos, indexed: true, cached: true, debug: {} });
  }
  if (env.ROUTES) {
    try {
      const cached = await env.ROUTES.get(cacheKey, { type: "json" });
      if (cached && Array.isArray(cached.photos) && cached.photos.length && cached.photos.every(function(p) { return p && p.url; })) {
        await writePhotoIndex(env, number, cached.photos);
        await Promise.all(cached.photos.map(function(f) {
          return env.ROUTES.put("pf2:" + f.id, JSON.stringify({ url: f.url }), { expirationTtl: PHOTO_FILE_CACHE_TTL });
        }));
        return json({ ok: true, number: number, photos: cached.photos, cached: true, debug: {} });
      }
    } catch (e) { /* без кеша */ }
  }
  const dbg = {};
  try {
    const files = await findPhotoFiles(webhook, number, dbg, quick, warm);
    const photos = files.map(function(f) { return { id: f.id, name: f.name, url: f.url || "" }; });
    if (env.ROUTES && files.length) {
      await writePhotoIndex(env, number, photos);
      await Promise.all(files.map(function(f) {
        return env.ROUTES.put("pf2:" + f.id, JSON.stringify({ url: f.url }), { expirationTtl: PHOTO_FILE_CACHE_TTL });
      }));
      await env.ROUTES.put(cacheKey, JSON.stringify({ photos: photos }), { expirationTtl: PHOTO_CACHE_TTL });
    }
    return json({ ok: true, number: number, photos: photos, quick: quick, warm: warm, debug: dbg });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), photos: [], debug: dbg }, 502);
  }
}

async function handlePhotoFile(url, env) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) return json({ error: "Неверный id" }, 400);
  if (!env.BITRIX_WEBHOOK_URL || !env.ROUTES) return json({ error: "Bitrix не настроен" }, 500);
  const allowed = await env.ROUTES.get("pf2:" + id, { type: "json" });
  const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");

  function isFile(r) {
    if (!r || !r.ok) return false;
    return !/text\/html/i.test(r.headers.get("Content-Type") || "");
  }

  let fileRes = null;
  let reason = "";
  if (allowed && allowed.url) {
    try {
      fileRes = await fetch(new URL(allowed.url, webhook).href, { redirect: "follow" });
    } catch (e) {
      fileRes = null;
      reason = "прямая ссылка недоступна";
    }
  }

  // ВАЖНО: id из im.dialog.messages.* — это ID вложения чата,
  // а не Drive ID для disk.file.get. Поэтому disk.file.get здесь не вызываем.
  // Если URL отсутствует/устарел, ищем сообщение по номеру и берём
  // urlDownload/urlShow непосредственно из ответа чата.
  if (!isFile(fileRes)) {
    // Для серверной загрузки chat-файла используем официальный метод
    // im.v2.File.download. Он возвращает временный downloadUrl,
    // предназначенный именно для скачивания через интеграцию.
    try {
      const dl = await bitrixCall(webhook, "im.v2.File.download", {
        dialogId: BITRIX_DIALOG_ID,
        fileId: Number(id)
      });
      const downloadUrl = dl && dl.result && (dl.result.downloadUrl || dl.result.urlDownload || dl.result.url || "");
      if (downloadUrl) {
        fileRes = await fetch(new URL(downloadUrl, webhook).href, { redirect: "follow" });
      } else {
        reason = "Bitrix не вернул ссылку на скачивание";
      }
    } catch (e) {
      reason = String((e && e.message) || e).slice(0, 160);
    }
  }

  // Если старый ID уже недействителен/не относится к найденному файлу,
  // номер отгрузки остаётся дополнительным способом заново найти актуальный ID.
  if (!isFile(fileRes)) {
    const number = (url.searchParams.get("number") || "").trim();
    if (number) {
      try {
        const dbg = {};
        const files = await findPhotoFiles(webhook, number, dbg, true, false);
        const match = files.find(function(f) { return String(f.id) === id; }) || files[0];
        if (match && /^\d+$/.test(String(match.id))) {
          const dl = await bitrixCall(webhook, "im.v2.File.download", {
            dialogId: BITRIX_DIALOG_ID,
            fileId: Number(match.id)
          });
          const downloadUrl = dl && dl.result && (dl.result.downloadUrl || dl.result.urlDownload || dl.result.url || "");
          if (downloadUrl) {
            fileRes = await fetch(new URL(downloadUrl, webhook).href, { redirect: "follow" });
          }
          if (isFile(fileRes)) {
            await env.ROUTES.put("pf2:" + String(match.id), JSON.stringify({ url: match.url || "" }), { expirationTtl: PHOTO_FILE_CACHE_TTL });
          }
        }
      } catch (e) {
        reason = String((e && e.message) || e).slice(0, 160);
      }
    }
  }

  if (!isFile(fileRes)) return json({ error: "Не удалось получить файл" + (reason ? " (" + reason + ")" : "") }, 502);
  return new Response(fileRes.body, {
    status: 200,
    headers: Object.assign({
      "Content-Type": fileRes.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "private, max-age=3600"
    }, corsHeaders())
  });
}

async function bitrixCall(webhook, method, payload, attempt) {
  attempt = attempt || 0;
  const r = await fetch(webhook + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(function() { return {}; });
  const code = String(data.error || "");
  if ((code === "QUERY_LIMIT_EXCEEDED" || r.status === 429 || r.status === 503) && attempt < 3) {
    await new Promise(function(res) { setTimeout(res, 700 * (attempt + 1)); });
    return bitrixCall(webhook, method, payload, attempt + 1);
  }
  if (!r.ok || data.error) throw new Error(data.error_description || data.error || "Bitrix " + r.status);
  return data;
}

async function handlePhotoUpload(request, auth, env) {
  if (!env.BITRIX_WEBHOOK_URL) return json({ error: "Bitrix не настроен" }, 500);
  if (!(await verifyAuth(auth))) return unauthorized();
  const body = await request.json();
  const number = String(body.number || "").trim();
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const by = String(body.by || "").trim();
  if (!number) return json({ error: "Не передан номер" }, 400);
  if (!photos.length) return json({ error: "Нет фото" }, 400);
  if (photos.length > 10) return json({ error: "Максимум 10 фото" }, 400);
  const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");
  const caption = "Отгрузка №" + number + (by ? " (загрузил: " + by + ")" : "");
  let uploaded = 0;
  const results = [];
  for (let base = 0; base < photos.length; base += 4) {
    const batch = photos.slice(base, base + 4);
    const batchResults = await Promise.all(batch.map(async function(p, off) {
      const i = base + off;
      if (!p || !p.content) return null;
      const name = String(p.name || ("order-" + number + "-" + (i + 1) + ".jpg")).replace(/[^a-zA-Z0-9А-Яа-я._-]/g, "_");
      const data = await bitrixCall(webhook, "im.v2.File.upload", {
        dialogId: BITRIX_DIALOG_ID,
        fields: { name: name, content: p.content, message: caption }
      });
      const uploadedFiles = extractUploadedFiles(data.result, [name]);
      return { name: name, result: data.result, files: uploadedFiles };
    }));
    for (let i = 0; i < batchResults.length; i++) {
      const item = batchResults[i];
      if (!item) continue;
      uploaded++;
      results.push(item);
    }
  }

  // Сразу сохраняем известные ID. Следующее открытие отгрузки вообще не обращается к истории чата.
  const indexedPhotos = [];
  for (let i = 0; i < results.length; i++) {
    const files = Array.isArray(results[i].files) ? results[i].files : [];
    for (let j = 0; j < files.length; j++) indexedPhotos.push(files[j]);
  }
  if (indexedPhotos.length) {
    await writePhotoIndex(env, number, indexedPhotos);
    await Promise.all(indexedPhotos.map(function(f) {
      return env.ROUTES.put("pf2:" + f.id, JSON.stringify({ url: f.url || "" }), { expirationTtl: PHOTO_FILE_CACHE_TTL });
    }));
  }
  return json({ ok: true, number: number, uploaded: uploaded, results: results });
}

async function handleBitrixTest(auth, env) {
  if (!env.BITRIX_WEBHOOK_URL) return json({ ok: false, error: "BITRIX_WEBHOOK_URL не задан" }, 500);
  if (!(await verifyAuth(auth))) return unauthorized();
  const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");
  try {
    const data = await bitrixCall(webhook, "im.dialog.get", { DIALOG_ID: BITRIX_DIALOG_ID });
    return json({ ok: true, chatId: BITRIX_CHAT_ID, dialogId: BITRIX_DIALOG_ID, chat: data.result || null });
  } catch (e) {
    return json({ ok: false, chatId: BITRIX_CHAT_ID, dialogId: BITRIX_DIALOG_ID, error: String(e) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    if (url.pathname === "/login" && request.method === "POST") return handleLogin(request, env);

    const auth = await getSessionAuth(request, env);
    if (!auth) return unauthorized();

    const username = getBasicUsername(auth);
    if (!isAllowedLogin(username)) return json({ error: "Доступ запрещён" }, 403);

    try {
      if (url.pathname === "/find" && request.method === "GET") return await handleFind(url, auth);
      if (url.pathname === "/ship" && request.method === "POST") return await handleShip(request, auth);
      if (url.pathname === "/finish" && request.method === "POST") return await handleFinish(request, auth);
      if (url.pathname === "/route/details" && request.method === "POST") return await handleRouteDetails(request, auth);
      if (url.pathname === "/route" && request.method === "POST") {
        if (!isAllowedRouteLogin(username)) return json({ error: "Нет прав" }, 403);
        return await handleRouteUpload(request, auth, env);
      }
      if (url.pathname === "/route" && request.method === "GET") return await handleRouteGet(url, auth, env);
      if (url.pathname === "/route/complete" && request.method === "POST") {
        if (!isAllowedRouteLogin(username)) return json({ error: "Нет прав" }, 403);
        return await handleRouteComplete(request, auth, env);
      }
      if (url.pathname === "/photo" && request.method === "GET") return await handlePhoto(url, auth, env);
      if (url.pathname === "/photo/file" && request.method === "GET") return await handlePhotoFile(url, env);
      if (url.pathname === "/photo/upload" && request.method === "POST") return await handlePhotoUpload(request, auth, env);
      if (url.pathname === "/bitrix/test" && request.method === "GET") return await handleBitrixTest(auth, env);
    } catch (e) {
      return json({ error: "Внутренняя ошибка" }, 500);
    }
    return json({ error: "Действие не разрешено" }, 403);
  }
};
