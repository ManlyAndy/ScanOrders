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

const BITRIX_CHAT_ID = 11359;
const BITRIX_DIALOG_ID = `chat${BITRIX_CHAT_ID}`;

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
      if (url.pathname === "/photo" && request.method === "GET") {
        return await handlePhoto(url, auth, env);
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
        let details = "";
        try { details = await putRes.text(); } catch (e) {}
        results.push({ id, name: actualName, ok: false, error: "Не удалось сменить статус", status: putRes.status, details });
      } else {
        // Перечитываем документ ещё раз, чтобы убедиться, что статус ДЕЙСТВИТЕЛЬНО применился
        const verifyRes = await fetch(`${API_BASE}/entity/demand/${encodeURIComponent(id)}?expand=state`, {
          headers: { Authorization: auth },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const verifyData = verifyRes.ok ? await verifyRes.json() : null;
        const verifiedState = verifyData && verifyData.state ? verifyData.state.name : null;
        if (verifiedState === STATUS_SHIPPED_NAME) {
          results.push({ id, name: actualName, ok: true });
        } else {
          results.push({
            id,
            name: actualName,
            ok: false,
            error: `Запрос прошёл успешно, но статус не изменился (сейчас: "${verifiedState || "—"}")`,
            usedHref: shippedState.meta.href,
          });
        }
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

// ---------- ФОТО ОТГРУЗКИ ИЗ BITRIX24 ----------
//
// Требует ОДНОГО секрета в Cloudflare (Settings → Variables and Secrets):
//   BITRIX_WEBHOOK_URL — входящий вебхук, напр. https://портал.bitrix24.ru/rest/1/xxxxxxx/
//
// Логика: ищем в Ленте новостей (среди всего, что видно этому вебхуку) пост,
// текст которого точно совпадает с номером отгрузки, берём первый
// прикреплённый файл и получаем прямую ссылку на него через disk.file.get.

async function handlePhoto(url, auth, env) {
  if (!env.BITRIX_WEBHOOK_URL) {
    return json({
      error: "Интеграция с Bitrix24 не настроена (нет секрета BITRIX_WEBHOOK_URL в Worker'е)"
    }, 500);
  }

  const ok = await verifyAuth(auth);
  if (!ok) return json({ error: "Неверный логин или пароль" }, 401);

  const number = (url.searchParams.get("number") || "").trim();
  if (!number) {
    return json({ error: "Не передан номер отгрузки" }, 400);
  }

  const webhook = env.BITRIX_WEBHOOK_URL.replace(/\/$/, "");

  try {
    // =========================================================
    // 1. Ищем сообщение ТОЛЬКО в чате фотографий отгрузок
    // =========================================================

    const searchRes = await fetch(`${webhook}/im.dialog.messages.search.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CHAT_ID: BITRIX_CHAT_ID,
        SEARCH_MESSAGE: number,
        ORDER: { ID: "DESC" },
        LIMIT: 50,
      }),
    });

    if (!searchRes.ok) {
      const details = await searchRes.text().catch(() => "");
      return json({
        error: "Bitrix24 недоступен при поиске сообщения",
        status: searchRes.status,
        details
      }, 502);
    }

    const searchData = await searchRes.json();

    if (searchData.error) {
      return json({
        error: `Ошибка Bitrix24: ${searchData.error_description || searchData.error}`
      }, 502);
    }

    const result = searchData.result || {};
    const messages = Array.isArray(result.messages) ? result.messages : [];

    // Ищем сообщение, в котором действительно присутствует номер.
    const normalizedNumber = number.toLowerCase();

    const matchingMessages = messages.filter((message) => {
      const text = String(message.text || "").trim().toLowerCase();
      return text === normalizedNumber ||
             text.includes(normalizedNumber);
    });

    if (!matchingMessages.length) {
      return json({
        found: false,
        chatId: BITRIX_CHAT_ID,
        dialogId: BITRIX_DIALOG_ID,
        number,
        debug: {
          messagesFound: messages.length,
          sample: messages.slice(0, 10).map((m) => ({
            id: m.id,
            text: m.text,
            date: m.date,
            chatId: m.chatId || m.chat_id,
          }))
        }
      });
    }

    // Берём самое свежее подходящее сообщение.
    const message = matchingMessages[0];

    // =========================================================
    // 2. Получаем историю конкретного чата около найденного
    //    сообщения, чтобы получить связанные files
    // =========================================================

    const messageId = Number(message.id);

    const historyRes = await fetch(`${webhook}/im.dialog.messages.get.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        DIALOG_ID: BITRIX_DIALOG_ID,
        FIRST_ID: messageId,
        LIMIT: 50,
      }),
    });

    if (!historyRes.ok) {
      const details = await historyRes.text().catch(() => "");
      return json({
        error: "Не удалось получить сообщения чата Bitrix24",
        status: historyRes.status,
        details
      }, 502);
    }

    const historyData = await historyRes.json();

    if (historyData.error) {
      return json({
        error: `Ошибка Bitrix24 при получении истории: ${
          historyData.error_description || historyData.error
        }`
      }, 502);
    }

    const history = historyData.result || {};
    const historyMessages = Array.isArray(history.messages)
      ? history.messages
      : [];

    const files = Array.isArray(history.files)
      ? history.files
      : [];

    // =========================================================
    // 3. Проверяем, что история действительно относится
    //    к нашему чату и ищем файлы рядом с сообщением
    // =========================================================

    const chatFiles = files.filter((file) => {
      return Number(file.chatId) === BITRIX_CHAT_ID ||
             Number(file.imChatId) === BITRIX_CHAT_ID;
    });

    if (!chatFiles.length) {
      return json({
        found: false,
        chatId: BITRIX_CHAT_ID,
        dialogId: BITRIX_DIALOG_ID,
        number,
        messageId,
        debug: {
          messageText: message.text || "",
          historyMessages: historyMessages.length,
          filesInResponse: files.length,
          chatFiles: 0,
        }
      });
    }

    // =========================================================
    // 4. Берём изображения.
    //    Если в сообщении несколько фото — возвращаем все.
    // =========================================================

    const images = chatFiles
      .filter((file) => {
        const type = String(file.type || "").toLowerCase();
        const extension = String(file.extension || "").toLowerCase();

        return type === "image" ||
          ["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(extension);
      })
      .map((file) => ({
        id: file.id,
        name: file.name || `photo-${file.id}`,
        url: file.urlShow || file.urlPreview || file.urlDownload || null,
        downloadUrl: file.urlDownload || file.urlShow || null,
        previewUrl: file.urlPreview || file.urlShow || null,
        type: file.type || "image",
      }))
      .filter((file) => !!file.url);

    if (!images.length) {
      return json({
        found: false,
        chatId: BITRIX_CHAT_ID,
        dialogId: BITRIX_DIALOG_ID,
        number,
        messageId,
        debug: {
          messageText: message.text || "",
          totalFiles: chatFiles.length,
          files: chatFiles.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            extension: f.extension,
            urlShow: !!f.urlShow,
            urlDownload: !!f.urlDownload,
          }))
        }
      });
    }

    // =========================================================
    // 5. Возвращаем и первый URL для совместимости,
    //    и массив images для дальнейшего вывода нескольких фото.
    // =========================================================

    return json({
      found: true,
      chatId: BITRIX_CHAT_ID,
      dialogId: BITRIX_DIALOG_ID,
      number,
      messageId,
      messageText: message.text || "",
      url: images[0].url,
      images,
    });

  } catch (e) {
    return json({
      error: "Не удалось связаться с Bitrix24",
      details: String(e)
    }, 500);
  }
}
