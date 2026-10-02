const API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const STATUS_READY_NAME = "Собрано";
const STATUS_SHIPPED_NAME = "Отгружено";
const PLACES_FIELD_NAME = "Количество мест";
const BITRIX_CHAT_ID = 11359;
const BITRIX_DIALOG_ID = "chat" + BITRIX_CHAT_ID;
const ALLOWED_ORIGIN = "https://manlyandy.github.io";
const SESSION_TTL = 28800;
const ROUTE_TTL = 15552000;

const ALLOWED_MS_LOGINS = new Set(["kovalkov@boss191", "harunin@boss191", "grishaev@boss191", "absaluttinova@boss191"]);
const ALLOWED_ROUTE_LOGINS = new Set(["kovalkov@boss191", "harunin@boss191", "grishaev@boss191", "absaluttinova@boss191"]);

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

function extractTCFromDescription(desc) {
  if (!desc) return "";
  const text = desc.replace(/[«»""'']/g, '"');
  const lines = text.split(/\n/);
  for (let line of lines) {
    line = line.trim();
    if (line.indexOf("ТК ") === 0) {
      let tc = line.substring(3).trim();
      tc = tc.replace(/^["']|["']$/g, '');
      const words = tc.split(/\s+/);
      const stopWords = ['до', 'в', 'по', 'на', 'от', 'для', 'терминала', 'терминалу', 'г.', 'г', 'получатель', 'плательщик', 'адрес', 'наб.', 'д.', 'корп.', 'кв.', 'тел.'];
      let result = [];
      for (let word of words) {
        const cleanWord = word.replace(/["',.]/g, '');
        if (stopWords.indexOf(cleanWord.toLowerCase()) >= 0) break;
        if (cleanWord) result.push(cleanWord);
      }
      return result.slice(0, 3).join(' ');
    }
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
        if (!res.ok) return { number: num, places: null, description: "", tc: "" };
        const data = await res.json();
        const row = data.rows && data.rows[0];
        if (!row) return { number: num, places: null, description: "", tc: "" };

        const detailRes = await fetch(API_BASE + "/entity/demand/" + row.id + "?expand=agent,state", {
          headers: { "Authorization": auth }
        });
        if (!detailRes.ok) return { number: num, places: null, description: "", tc: "" };
        const detail = await detailRes.json();

        return {
          number: num,
          places: extractPlaces(detail),
          description: detail.description || "",
          tc: extractTCFromDescription(detail.description)
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

async function handlePhoto(url, auth, env) {
  const number = (url.searchParams.get("number") || "").trim();
  if (!number) return json({ error: "Не передан номер" }, 400);
  if (!(await verifyAuth(auth))) return unauthorized();

  if (!env.BITRIX_WEBHOOK_URL) return json({ photos: [] });

  try {
    const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");
    const photos = [];
    let lastId = null;
    let checked = 0;
    const maxMessages = 300;

    while (checked < maxMessages) {
      const params = {
        DIALOG_ID: BITRIX_DIALOG_ID,
        LIMIT: 50
      };
      if (lastId) params.LAST_ID = lastId;

      const res = await fetch(webhook + "/im.dialog.messages.get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      });

      if (!res.ok) break;
      const data = await res.json();
      const messages = data.result || [];

      if (messages.length === 0) break;

      for (let i = 0; i < messages.length; i++) {
        checked++;
        const msg = messages[i];
        const text = String(msg.message || "").toLowerCase();
        const needle = "отгрузка №" + number.toLowerCase();

        if (text.indexOf(needle) >= 0) {
          const files = msg.files || msg.FILES || {};
          for (const fileId in files) {
            if (!files.hasOwnProperty(fileId)) continue;
            const file = files[fileId];
            if (!file) continue;
            const fileUrl = file.showUrl || file.url || file.downloadUrl || "";
            if (fileUrl) {
              const fullUrl = fileUrl.indexOf("http") === 0 ? fileUrl : webhook + fileUrl;
              photos.push(fullUrl);
            }
          }
          const attach = msg.attach || msg.ATTACH || [];
          if (Array.isArray(attach)) {
            for (let j = 0; j < attach.length; j++) {
              const att = attach[j];
              if (att && att.type === "image" && att.url) {
                const fullUrl = att.url.indexOf("http") === 0 ? att.url : webhook + att.url;
                photos.push(fullUrl);
              }
            }
          }
        }
        lastId = msg.id;
      }

      if (messages.length < 50) break;
    }

    return json({ photos: photos });
  } catch (e) {
    console.error("handlePhoto error:", e);
    return json({ photos: [] });
  }
}
    
    if (!messagesRes.ok) return json({ photos: [] });
    const messagesData = await messagesRes.json();
    
    const photos = [];
    const messages = messagesData.result || [];
    
    // Ищем сообщения с фото для этой отгрузки
    for (const msg of messages) {
      if (msg.MESSAGE && msg.MESSAGE.indexOf("Отгрузка №" + number) >= 0 && msg.FILES) {
        for (const fileId in msg.FILES) {
          const file = msg.FILES[fileId];
          if (file && file.filePath) {
            photos.push(webhook + file.filePath);
          }
        }
      }
    }
    
    return json({ photos: photos });
   catch (e) {
    return json({ photos: [] });
  }
}

async function bitrixCall(webhook, method, payload) {
  const r = await fetch(webhook + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(function() { return {}; });
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
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || !p.content) continue;
    const name = String(p.name || ("order-" + number + "-" + (i + 1) + ".jpg")).replace(/[^a-zA-Z0-9А-Яа-я._-]/g, "_");
    const data = await bitrixCall(webhook, "im.v2.File.upload", {
      dialogId: BITRIX_DIALOG_ID,
      fields: { name: name, content: p.content, message: caption }
    });
    uploaded++;
    results.push({ name: name, result: data.result });
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
      if (url.pathname === "/photo/upload" && request.method === "POST") return await handlePhotoUpload(request, auth, env);
      if (url.pathname === "/bitrix/test" && request.method === "GET") return await handleBitrixTest(auth, env);
    } catch (e) {
      return json({ error: "Внутренняя ошибка" }, 500);
    }
    return json({ error: "Действие не разрешено" }, 403);
  }
};
