const API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const STATUS_READY_NAME = "Собрано";
const STATUS_SHIPPED_NAME = "Отгружено";
const PLACES_FIELD_NAME = "Количество мест";
const BITRIX_CHAT_ID = 11359;
const BITRIX_DIALOG_ID = `chat${BITRIX_CHAT_ID}`;
const ALLOWED_ORIGIN = "https://manlyandy.github.io";
const SESSION_TTL = 28800;

const ALLOWED_MS_LOGINS = new Set([
  "kovalkov@boss191"

].map(v => v.trim().toLowerCase()).filter(Boolean));

const ALLOWED_ROUTE_LOGINS = new Set([
  "kovalkov@boss191"
].map(v => v.trim().toLowerCase()).filter(Boolean));

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...corsHeaders()
    }
  });
}

function getBasicUsername(auth) {
  try {
    if (!auth || !auth.startsWith("Basic ")) return "";
    const raw = atob(auth.slice(6));
    const colon = raw.indexOf(":");
    return colon >= 0 ? raw.slice(0, colon).trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function isAllowedLogin(username) {
  return ALLOWED_MS_LOGINS.has(String(username || "").trim().toLowerCase());
}

function isAllowedRouteLogin(username) {
  return ALLOWED_ROUTE_LOGINS.has(String(username || "").trim().toLowerCase());
}

async function verifyAuth(auth) {
  if (!auth?.startsWith("Basic ")) return false;
  const res = await fetch(`${API_BASE}/entity/employee?limit=1`, {
    headers: { Authorization: auth }
  });
  return res.ok;
}

async function createSession(auth, env) {
  if (!env.ROUTES) return null;
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, b => b.toString(16).padStart(2, "0")).join("");
  await env.ROUTES.put(`session:${token}`, auth, { expirationTtl: SESSION_TTL });
  return token;
}

async function getSessionAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ") || !env.ROUTES) return null;
  const token = header.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return await env.ROUTES.get(`session:${token}`);
}

function unauthorized() {
  return json({ error: "Сессия недействительна или истекла" }, 401);
}

async function handleLogin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return unauthorized();

  const username = getBasicUsername(auth);
  if (!isAllowedLogin(username)) return json({ error: "Доступ к приложению запрещён" }, 403);
  if (!(await verifyAuth(auth))) return json({ error: "Неверный логин или пароль" }, 401);

  const token = await createSession(auth, env);
  if (!token) return json({ error: "Сервер авторизации не настроен" }, 500);
  return json({ ok: true, token, expiresIn: SESSION_TTL, user: username });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/login" && request.method === "POST") return handleLogin(request, env);

    const auth = await getSessionAuth(request, env);
    if (!auth) return unauthorized();

    const username = getBasicUsername(auth);
    if (!isAllowedLogin(username)) return json({ error: "Доступ к приложению запрещён" }, 403);

    try {
      if (url.pathname === "/find" && request.method === "GET") return await handleFind(url, auth);
      if (url.pathname === "/ship" && request.method === "POST") return await handleShip(request, auth);
      if (url.pathname === "/finish" && request.method === "POST") return await handleFinish(request, auth);
      if (url.pathname === "/route" && request.method === "POST") {
        if (!isAllowedRouteLogin(username)) return json({ error: "У вас нет права изменять маршруты" }, 403);
        return await handleRouteUpload(request, auth, env);
      }
      if (url.pathname === "/route" && request.method === "GET") return await handleRouteGet(url, auth, env);
      if (url.pathname === "/photo" && request.method === "GET") return await handlePhoto(url, auth, env);
    } catch {
      return json({ error: "Внутренняя ошибка" }, 500);
    }

    return json({ error: "Действие не разрешено" }, 403);
  }
};

async function handleFind(url, auth) {
  const code = (url.searchParams.get("code") || "").trim();
  if (!code) return json({ error: "Не передан номер" }, 400);

  const filter = encodeURIComponent(`name=${code}`);
  const res = await fetch(`${API_BASE}/entity/demand?filter=${filter}&expand=agent,state`, {
    headers: { Authorization: auth },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (res.status === 401) return unauthorized();
  if (!res.ok) return json({ error: "Ошибка МойСклад" }, 502);

  const data = await res.json();
  const row = data.rows && data.rows[0];
  if (!row) return json({ found: false });

  const detailRes = await fetch(`${API_BASE}/entity/demand/${row.id}?expand=agent,state`, {
    headers: { Authorization: auth }
  });
  if (!detailRes.ok) return json({ error: "Не удалось получить данные отгрузки" }, 502);

  const detail = await detailRes.json();
  const stateName = detail.state ? detail.state.name : null;
  const places = extractPlaces(detail);

  return json({
    found: true,
    id: detail.id,
    name: detail.name,
    agentName: detail.agent ? detail.agent.name : "—",
    sum: detail.sum ? (detail.sum / 100).toFixed(2) : "—",
    positionsCount: detail.positions && detail.positions.meta ? detail.positions.meta.size : "—",
    places,
    stateName,
    ready: stateName === STATUS_READY_NAME,
    alreadyShipped: stateName === STATUS_SHIPPED_NAME
  });
}

function extractPlaces(row) {
  const attrs = Array.isArray(row.attributes) ? row.attributes : [];
  const exact = attrs.find(a => String(a.name || "").trim().toLowerCase() === PLACES_FIELD_NAME.toLowerCase());
  const flexible = attrs.find(a => /количеств.*мест/i.test(String(a.name || "")));
  const attr = exact || flexible;
  if (!attr) return null;
  const value = attr.value;
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    if (value.value !== undefined) return value.value;
    if (value.name !== undefined) return value.name;
  }
  return value;
}

async function handleShip(request, auth) {
  const body = await request.json();
  const id = body.id;
  if (!id) return json({ error: "Не передан id отгрузки" }, 400);

  const demandRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}?expand=state`, {
    headers: { Authorization: auth },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (demandRes.status === 401) return unauthorized();
  if (!demandRes.ok) return json({ error: "Не удалось проверить отгрузку" }, 502);

  const demand = await demandRes.json();
  const currentState = demand.state ? demand.state.name : null;
  if (currentState !== STATUS_READY_NAME) {
    return json({ ok: false, error: `Отгрузка сейчас в статусе "${currentState || "—"}"` }, 409);
  }

  const metaRes = await fetch(`${API_BASE}/entity/demand/metadata`, { headers: { Authorization: auth } });
  if (!metaRes.ok) return json({ error: "Не удалось получить настройки МойСклад" }, 502);
  const meta = await metaRes.json();
  const states = meta.states || meta.states?.rows || [];
  const shippedState = states.find(s => s.name === STATUS_SHIPPED_NAME);
  if (!shippedState) return json({ error: "Статус отгрузки не найден" }, 500);

  const putRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ state: { meta: shippedState.meta } })
  });
  if (putRes.status === 401) return unauthorized();
  if (!putRes.ok) return json({ error: "Не удалось сменить статус" }, 502);

  return json({ ok: true });
}

async function handleFinish(request, auth) {
  const body = await request.json();
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(Boolean))].slice(0, 100) : [];
  if (!ids.length) return json({ error: "Список отгрузок пуст" }, 400);

  const results = [];
  for (const id of ids) {
    try {
      const demandRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}?expand=state`, {
        headers: { Authorization: auth },
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      if (demandRes.status === 401) return unauthorized();
      if (!demandRes.ok) {
        results.push({ id, ok: false, error: "Не удалось проверить отгрузку" });
        continue;
      }
      const demand = await demandRes.json();
      const currentState = demand.state ? demand.state.name : null;
      if (currentState === STATUS_SHIPPED_NAME) {
        results.push({ id, ok: true, alreadyShipped: true });
        continue;
      }
      if (currentState !== STATUS_READY_NAME) {
        results.push({ id, ok: false, error: `Отгрузка сейчас в статусе "${currentState || "—"}"` });
        continue;
      }

      const metaRes = await fetch(`${API_BASE}/entity/demand/metadata`, { headers: { Authorization: auth } });
      if (!metaRes.ok) {
        results.push({ id, ok: false, error: "Не удалось получить настройки МойСклад" });
        continue;
      }
      const meta = await metaRes.json();
      const states = meta.states || meta.states?.rows || [];
      const shippedState = states.find(s => s.name === STATUS_SHIPPED_NAME);
      if (!shippedState) {
        results.push({ id, ok: false, error: "Статус отгрузки не найден" });
        continue;
      }

      const putRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ state: { meta: shippedState.meta } })
      });
      if (putRes.status === 401) return unauthorized();
      if (!putRes.ok) {
        results.push({ id, ok: false, error: "Не удалось сменить статус" });
        continue;
      }
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false, error: "Ошибка соединения с МойСклад" });
    }
  }

  const success = results.filter(x => x.ok || x.alreadyShipped).length;
  const failed = results.length - success;
  return json({ ok: failed === 0, total: results.length, success, failed, results });
}

function routeKey(date) {
  return `route:${date}`;
}

async function handleRouteUpload(request, auth, env) {
  if (!env.ROUTES) return json({ error: "Хранилище маршрутов не подключено" }, 500);
  if (!(await verifyAuth(auth))) return unauthorized();

  const body = await request.json();
  const date = (body.date || "").trim();
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers.map(x => String(x).trim()).filter(Boolean))].slice(0, 1000) : [];
  const label = (body.label || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Неверный формат даты" }, 400);
  if (!numbers.length) return json({ error: "Список номеров пуст" }, 400);
  if (!label || label.length > 100) return json({ error: "Неверное название маршрута" }, 400);

  const key = routeKey(date);
  const existing = await env.ROUTES.get(key, { type: "json" });
  const items = Array.isArray(existing?.items) ? existing.items : [];
  const filtered = items.filter(item => item.label !== label);
  filtered.push(...numbers.map(number => ({ number, label })));
  await env.ROUTES.put(key, JSON.stringify({ date, items: filtered }));

  return json({ ok: true, count: filtered.length });
}

async function handleRouteGet(url, auth, env) {
  if (!env.ROUTES) return json({ error: "Хранилище маршрутов не подключено" }, 500);
  const date = (url.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Неверный формат даты" }, 400);
  if (!(await verifyAuth(auth))) return unauthorized();

  const data = await env.ROUTES.get(routeKey(date), { type: "json" });
  return json(data ? { found: true, ...data } : { found: false, date });
}

async function handlePhoto(url, auth, env) {
  const number = (url.searchParams.get("number") || "").trim();
  if (!number) return json({ error: "Не передан номер" }, 400);
  if (!(await verifyAuth(auth))) return unauthorized();
  return json({ ok: false, error: "Фото не поддерживается этим Worker" }, 501);
}
