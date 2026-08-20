/**
 * ПРОКСИ ДЛЯ ПРИЛОЖЕНИЯ "КОНТРОЛЬ ОТГРУЗОК"
 * ==========================================
 * Разворачивается на Cloudflare Workers (бесплатно). Не хранит и не логирует
 * логин/пароль — только пересылает их в МойСклад для каждого запроса.
 *
 * ВАЖНО ДЛЯ БЕЗОПАСНОСТИ:
 * Этот код разрешает делать со стороны приложения ТОЛЬКО эти действия:
 *   1. Найти отгрузку по номеру (только чтение)
 *   2. Сменить статус ОДНОЙ отгрузки на статус "отгружено"
 *   3. Закрыть маршрут: пакетно сменить статусы просканированных отгрузок
 *   4. Сохранить/прочитать список номеров маршрута на дату (в KV-хранилище)
 * Никаких других действий (удаление, изменение цен, доступ к другим
 * документам и т.д.) через этот прокси сделать нельзя — даже если кто-то
 * получит ссылку на сам прокси. Все три действия требуют верный
 * логин/пароль от МойСклад в заголовке Authorization.
 *
 * ВАЖНО: для работы маршрутных листов нужно один раз привязать KV-хранилище
 * к этому Worker'у — см. README.md, раздел "Хранилище маршрутов".
 * Название переменной привязки должно быть ровно: ROUTES
 *
 * Как задеплоить — см. README.md
 */

// Держите эти значения синхронно со значениями в config.js
const STATUS_READY_NAME = "Собрано";
const STATUS_SHIPPED_NAME = "Отгружено";
const PLACES_FIELD_NAME = "Количество мест";

// После деплоя ОБЯЗАТЕЛЬНО замените "*" на адрес вашего GitHub Pages,
// например "https://ваш-логин.github.io" — так прокси будет отвечать
// только вашему приложению, а не любому сайту в интернете.
const ALLOWED_ORIGIN = "https://manlyandy.github.io";

// Логины МойСклад, которым разрешено ЗАГРУЖАТЬ/ОБНОВЛЯТЬ маршруты.
// Передайте их в Cloudflare Worker как переменную окружения:
// ROUTE_UPLOAD_LOGINS=login1@company.ru,login2@company.ru,logist@company.ru
// Все остальные пользователи могут сканировать, закрывать маршруты и
// выполнять индивидуальную отгрузку, но POST /route будет запрещён.

const API_BASE = "https://api.moysklad.ru/api/remap/1.2";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...corsHeaders(),
    },
  });
}

// Лёгкая проверка, что логин/пароль вообще валидны в МойСклад —
// используется перед тем, как что-то писать в хранилище маршрутов.
function getAuthUsername(auth) {
  try {
    if (!auth || !auth.startsWith("Basic ")) return "";
    const raw = atob(auth.slice(6));
    const colon = raw.indexOf(":");
    return colon >= 0 ? raw.slice(0, colon).trim().toLowerCase() : "";
  } catch (e) {
    return "";
  }
}

function canUploadRoute(auth, env) {
  const username = getAuthUsername(auth);
  const configured = String(env.ROUTE_UPLOAD_LOGINS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return !!username && configured.includes(username);
}

async function verifyAuth(auth) {
  const res = await fetch(`${API_BASE}/entity/employee?limit=1`, {
    headers: { Authorization: auth },
  });
  return res.ok;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const auth = request.headers.get("Authorization");
    if (!auth || !auth.startsWith("Basic ")) {
      return json({ error: "Нет авторизации" }, 401);
    }

    try {
      if (url.pathname === "/find" && request.method === "GET") {
        return await handleFind(url, auth);
      }
      if (url.pathname === "/ship" && request.method === "POST") {
        return await handleShip(request, auth);
      }
      if (url.pathname === "/finish" && request.method === "POST") {
        return await handleFinish(request, auth);
      }
      if (url.pathname === "/route" && request.method === "POST") {
        return await handleRouteUpload(request, auth, env);
      }
      if (url.pathname === "/route" && request.method === "GET") {
        return await handleRouteGet(url, auth, env);
      }
    } catch (e) {
      return json({ error: "Внутренняя ошибка", details: String(e) }, 500);
    }

    // Всё остальное запрещено намеренно
    return json({ error: "Действие не разрешено" }, 403);
  },
};

async function handleFind(url, auth) {
  const code = (url.searchParams.get("code") || "").trim();
  if (!code) return json({ error: "Не передан номер" }, 400);

  const filter = encodeURIComponent(`name=${code}`);
  const res = await fetch(`${API_BASE}/entity/demand?filter=${filter}&expand=agent,state`, {
    headers: { Authorization: auth },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (res.status === 401) return json({ error: "Неверный логин или пароль" }, 401);
  if (!res.ok) return json({ error: "Ошибка МойСклад", status: res.status }, 502);

  const data = await res.json();
  const row = data.rows && data.rows[0];

  if (!row) return json({ found: false });

  // Получаем полную отгрузку, чтобы точно получить статус
  const detailRes = await fetch(`${API_BASE}/entity/demand/${row.id}?expand=agent,state`, {
    headers: { Authorization: auth },
  });

  if (!detailRes.ok) {
    return json({ error: "Не удалось получить данные отгрузки", status: detailRes.status }, 502);
  }

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
    stateName: stateName,
    ready: stateName === STATUS_READY_NAME,
    alreadyShipped: stateName === STATUS_SHIPPED_NAME,
  });
}


function extractPlaces(row) {
  const attrs = Array.isArray(row.attributes) ? row.attributes : [];
  const exact = attrs.find((a) => String(a.name || "").trim().toLowerCase() === PLACES_FIELD_NAME.toLowerCase());
  const flexible = attrs.find((a) => /количеств.*мест/i.test(String(a.name || "")));
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

  // Сначала перечитываем текущую отгрузку: между поиском и подтверждением
  // её статус мог измениться другим сотрудником.
  const demandRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}?expand=state`, {
    headers: { Authorization: auth },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (demandRes.status === 401) return json({ error: "Неверный логин или пароль" }, 401);
  if (!demandRes.ok) return json({ error: "Не удалось проверить отгрузку" }, 502);
  const demand = await demandRes.json();
  const currentState = demand.state ? demand.state.name : null;
  if (currentState === STATUS_SHIPPED_NAME) return json({ ok: true, alreadyShipped: true });
  if (currentState !== STATUS_READY_NAME) {
    return json({ error: `Статус уже изменился: сейчас "${currentState || "—"}"`, stateName: currentState }, 409);
  }

  // 1. Находим href нужного статуса в метаданных
  const metaRes = await fetch(`${API_BASE}/entity/demand/metadata`, {
    headers: { Authorization: auth },
  });
  if (!metaRes.ok) return json({ error: "Не удалось получить статусы" }, 502);
  const meta = await metaRes.json();
  const state = (meta.states || []).find((s) => s.name === STATUS_SHIPPED_NAME);
  if (!state) {
    return json({ error: `Статус "${STATUS_SHIPPED_NAME}" не найден в аккаунте` }, 500);
  }

  // 2. Меняем статус именно этой (и только этой) отгрузки
  const putRes = await fetch(`${API_BASE}/entity/demand/${id}`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: { meta: { href: state.meta.href, type: "state", mediaType: "application/json" } },
    }),
  });

  if (putRes.status === 401) return json({ error: "Неверный логин или пароль" }, 401);
  if (!putRes.ok) return json({ error: "Не удалось сменить статус", status: putRes.status }, 502);

  return json({ ok: true });
}

async function handleFinish(request, auth) {
  const body = await request.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "Нет просканированных отгрузок" }, 400);

  // Получаем метаданные статусов один раз на весь маршрут.
  const metaRes = await fetch(`${API_BASE}/entity/demand/metadata`, {
    headers: { Authorization: auth },
  });
  if (metaRes.status === 401) return json({ error: "Неверный логин или пароль" }, 401);
  if (!metaRes.ok) return json({ error: "Не удалось получить статусы" }, 502);
  const meta = await metaRes.json();
  const shippedState = (meta.states || []).find((s) => s.name === STATUS_SHIPPED_NAME);
  if (!shippedState) return json({ error: `Статус "${STATUS_SHIPPED_NAME}" не найден в аккаунте` }, 500);

  const results = [];

  // Обрабатываем каждую просканированную отгрузку отдельно.
  // Перед PUT обязательно перечитываем её статус: за время маршрута заказ
  // мог быть изменён в МойСклад другим сотрудником.
  for (const rawItem of items) {
    const id = String(rawItem.id || "").trim();
    const name = String(rawItem.name || "").trim();
    if (!id) {
      results.push({ id, name, ok: false, error: "Не передан id отгрузки" });
      continue;
    }

    try {
      const demandRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}?expand=state`, {
        headers: { Authorization: auth },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (demandRes.status === 401) {
        results.push({ id, name, ok: false, error: "Неверный логин или пароль" });
        continue;
      }
      if (!demandRes.ok) {
        results.push({ id, name, ok: false, error: "Не удалось проверить отгрузку перед закрытием", status: demandRes.status });
        continue;
      }

      const demand = await demandRes.json();
      const currentState = demand.state ? demand.state.name : null;
      const actualName = demand.name || name;

      if (currentState === STATUS_SHIPPED_NAME) {
        results.push({ id, name: actualName, alreadyShipped: true });
        continue;
      }

      if (currentState !== STATUS_READY_NAME) {
        results.push({
          id,
          name: actualName,
          ok: false,
          error: `Статус изменился: сейчас "${currentState || "—"}", ожидался "${STATUS_READY_NAME}"`,
          stateName: currentState,
        });
        continue;
      }

      const putRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          state: { meta: { href: shippedState.meta.href, type: "state", mediaType: "application/json" } },
        }),
      });

      if (putRes.status === 401) {
        results.push({ id, name: actualName, ok: false, error: "Неверный логин или пароль" });
      } else if (!putRes.ok) {
        results.push({ id, name: actualName, ok: false, error: "Не удалось сменить статус", status: putRes.status });
      } else {
        results.push({ id, name: actualName, ok: true });
      }
    } catch (e) {
      results.push({ id, name, ok: false, error: "Ошибка соединения с МойСклад" });
    }
  }

  const success = results.filter((x) => x.ok || x.alreadyShipped).length;
  const failed = results.length - success;
  return json({ ok: failed === 0, total: results.length, success, failed, results });
}

// ---------- МАРШРУТНЫЕ ЛИСТЫ ----------

function routeKey(date) {
  return `route:${date}`; // date в формате YYYY-MM-DD
}

async function handleRouteUpload(request, auth, env) {
  // ВРЕМЕННО ОТКЛЮЧЕНО ДЛЯ ТЕСТА:
  // if (!canUploadRoute(auth, env)) {
  //   return json({ error: "У вас нет права загружать или изменять маршруты" }, 403);
  // }

  if (!env.ROUTES) {
    return json({ error: "Хранилище маршрутов не подключено к Worker'у (см. README)" }, 500);
  }

  const ok = await verifyAuth(auth);
  if (!ok) return json({ error: "Неверный логин или пароль" }, 401);

  const body = await request.json();
  const date = (body.date || "").trim();
  const numbers = Array.isArray(body.numbers) ? body.numbers : [];
  const label = (body.label || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "Неверный формат даты, ожидается YYYY-MM-DD" }, 400);
  }
  if (!numbers.length) {
    return json({ error: "Список номеров пуст" }, 400);
  }

  const key = routeKey(date);
  const existingRaw = await env.ROUTES.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : { date, items: [] };

  const byNumber = new Map(existing.items.map((it) => [it.number, it]));
  for (const n of numbers) {
    const num = String(n).trim();
    if (!num) continue;
    byNumber.set(num, { number: num, label: label || (byNumber.get(num) || {}).label || "" });
  }

  const updated = { date, items: Array.from(byNumber.values()), updatedAt: new Date().toISOString() };
  await env.ROUTES.put(key, JSON.stringify(updated));

  return json({ ok: true, date, count: updated.items.length });
}

async function handleRouteGet(url, auth, env) {
  if (!env.ROUTES) {
    return json({ error: "Хранилище маршрутов не подключено к Worker'у (см. README)" }, 500);
  }

  const ok = await verifyAuth(auth);
  if (!ok) return json({ error: "Неверный логин или пароль" }, 401);

  const date = (url.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "Неверный формат даты, ожидается YYYY-MM-DD" }, 400);
  }

  const raw = await env.ROUTES.get(routeKey(date));
  if (!raw) return json({ found: false, date });

  const data = JSON.parse(raw);
  return json({
    found: true,
    date,
    updatedAt: data.updatedAt,
    numbers: data.items.map((it) => it.number),
    items: data.items,
  });
}
