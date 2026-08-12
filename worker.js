/**
 * ПРОКСИ ДЛЯ ПРИЛОЖЕНИЯ "КОНТРОЛЬ ОТГРУЗОК"
 * ==========================================
 * Разворачивается на Cloudflare Workers (бесплатно). Не хранит и не логирует
 * логин/пароль — только пересылает их в МойСклад для каждого запроса.
 *
 * ВАЖНО ДЛЯ БЕЗОПАСНОСТИ:
 * Этот код разрешает делать со стороны приложения ТОЛЬКО две вещи:
 *   1. Найти отгрузку по номеру (только чтение)
 *   2. Сменить статус ОДНОЙ отгрузки на статус "отгружено"
 * Никаких других действий (удаление, изменение цен, доступ к другим
 * документам и т.д.) через этот прокси сделать нельзя — даже если кто-то
 * получит ссылку на сам прокси.
 *
 * Как задеплоить — см. README.md
 */

// Держите эти значения синхронно со значениями в config.js
const STATUS_READY_NAME = "Собрано";
const STATUS_SHIPPED_NAME = "Отгружено";

// После деплоя ОБЯЗАТЕЛЬНО замените "*" на адрес вашего GitHub Pages,
// например "https://ваш-логин.github.io" — так прокси будет отвечать
// только вашему приложению, а не любому сайту в интернете.
const ALLOWED_ORIGIN = "*";

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
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request) {
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
  const res = await fetch(`${API_BASE}/entity/demand?filter=${filter}`, {
    headers: { Authorization: auth, "Accept-Encoding": "identity" },
  });

  if (res.status === 401) return json({ error: "Неверный логин или пароль" }, 401);
  if (!res.ok) return json({ error: "Ошибка МойСклад", status: res.status }, 502);

  const data = await res.json();
  const row = data.rows && data.rows[0];

  if (!row) return json({ found: false });

  const stateName = row.state ? row.state.name : null;

  return json({
    found: true,
    id: row.id,
    name: row.name,
    agentName: row.agent ? row.agent.name : "—",
    sum: row.sum ? (row.sum / 100).toFixed(2) : "—",
    positionsCount: row.positions && row.positions.meta ? row.positions.meta.size : "—",
    stateName: stateName,
    ready: stateName === STATUS_READY_NAME,
    alreadyShipped: stateName === STATUS_SHIPPED_NAME,
  });
}

async function handleShip(request, auth) {
  const body = await request.json();
  const id = body.id;
  if (!id) return json({ error: "Не передан id отгрузки" }, 400);

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
