import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer, parseAndValidateModelOutput } from "./server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createTriageServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postTriage(rawBody) {
  const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}

test("успешный разбор: тема delivery", async () => {
  const res = await postTriage({ text: "  Когда будет доставка заказа?  " });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(res.data, {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("успешный разбор: тема pricing (по словам цена и стоимость)", async () => {
  const resPrice = await postTriage({ text: "Какая цена тарифа?" });
  assert.equal(resPrice.status, 200);
  assert.equal(resPrice.data.status, "ready");
  assert.equal(resPrice.data.topic, "pricing");

  const resCost = await postTriage({ text: "Подскажите стоимость подписки" });
  assert.equal(resCost.status, 200);
  assert.equal(resCost.data.status, "ready");
  assert.equal(resCost.data.topic, "pricing");
});

test("успешный разбор: тема other для общих вопросов", async () => {
  const res = await postTriage({ text: "Здравствуйте, хочу уточнить режим работы" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "ready",
    topic: "other",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("некорректный ввод: пустая строка и строка из пробелов возвращают 400 invalid_input", async () => {
  for (const text of ["", " ", "   \n\t\r  "]) {
    const res = await postTriage({ text });
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { status: "invalid_input" });
  }
});

test("некорректный ввод: отсутствие поля text или нестроковые типы возвращают 400 invalid_input", async () => {
  for (const invalidPayload of [
    {},
    { message: "текст не в том поле" },
    { text: null },
    { text: 42 },
    { text: false },
    { text: ["массив"] },
    { text: { nested: "объект" } },
  ]) {
    const res = await postTriage(invalidPayload);
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { status: "invalid_input" });
  }
});

test("некорректный ввод: битый JSON, пустое тело или JSON-примитив/массив возвращают 400 invalid_input", async () => {
  for (const rawBody of ["", "{broken json", "null", "[]", '"просто строка"', "123"]) {
    const res = await postTriage(rawBody);
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { status: "invalid_input" });
  }
});

test("сбой модели [timeout]: обрывает ожидание за ~300 мс и возвращает 200 manual_review", async () => {
  const startedAt = Date.now();
  const res = await postTriage({ text: "Заявка с зависанием [timeout]" });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
  assert.ok(elapsedMs >= 250 && elapsedMs < 800);
});

test("сбой модели [error]: при исключении провайдера возвращает 200 manual_review", async () => {
  const res = await postTriage({ text: "Заявка со сбоем провайдера [error]" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
});

test("сбой модели [bad-json]: при невалидном JSON от модели возвращает 200 manual_review", async () => {
  const res = await postTriage({ text: "Заявка с битым ответом [bad-json]" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
});

test("сбой модели [bad-topic]: при неизвестной теме (refund) возвращает 200 manual_review", async () => {
  const res = await postTriage({ text: "Заявка с неизвестной темой [bad-topic]" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
});

test("сбой модели [empty-draft]: при черновике из пробелов возвращает 200 manual_review", async () => {
  const res = await postTriage({ text: "Заявка с пустым черновиком [empty-draft]" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
});

test("кастомный классификатор: передаёт AbortSignal и обрывает зависший промис без поддержки signal", async () => {
  let receivedSignal = null;
  const customServer = createTriageServer({
    timeoutMs: 50,
    classifier: async (_text, { signal } = {}) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });

  await new Promise((resolve) => customServer.listen(0, "127.0.0.1", resolve));
  const { port } = customServer.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Тест зависания" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "manual_review",
      topic: null,
      draft: null,
    });
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    await new Promise((resolve) => customServer.close(resolve));
  }
});

test("parseAndValidateModelOutput: проверяет граничные форматы ответа модели", () => {
  assert.equal(parseAndValidateModelOutput(null), null);
  assert.equal(parseAndValidateModelOutput(undefined), null);
  assert.equal(parseAndValidateModelOutput(123), null);
  assert.equal(parseAndValidateModelOutput("not json"), null);
  assert.equal(parseAndValidateModelOutput("null"), null);
  assert.equal(parseAndValidateModelOutput("[]"), null);
  assert.equal(parseAndValidateModelOutput(JSON.stringify({ topic: "unknown", draft: "   " })), null);
  assert.equal(parseAndValidateModelOutput(JSON.stringify({ topic: "Delivery", draft: "Текст" })), null);
  assert.equal(parseAndValidateModelOutput(JSON.stringify({ topic: "delivery", draft: "" })), null);
  assert.equal(parseAndValidateModelOutput(JSON.stringify({ topic: "delivery", draft: " \n\t " })), null);

  assert.deepEqual(
    parseAndValidateModelOutput(JSON.stringify({ topic: "pricing", draft: "  Готовый ответ  " })),
    { topic: "pricing", draft: "Готовый ответ" },
  );
});

test("маршрутизация: GET / отдаёт HTML-страницу, неизвестные маршруты и методы возвращают 404 not_found", async () => {
  const homeRes = await fetch(`${baseUrl}/`);
  assert.equal(homeRes.status, 200);
  assert.match(homeRes.headers.get("content-type"), /text\/html/);
  const html = await homeRes.text();
  assert.ok(html.includes("<form"));
  assert.ok(html.includes("clearDraftAndTopic"));

  const getTriage = await fetch(`${baseUrl}/api/triage`, { method: "GET" });
  assert.equal(getTriage.status, 404);
  assert.deepEqual(await getTriage.json(), { status: "not_found" });

  const unknownRoute = await fetch(`${baseUrl}/api/unknown`, { method: "POST" });
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(await unknownRoute.json(), { status: "not_found" });
});
