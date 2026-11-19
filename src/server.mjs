import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const AI_TIMEOUT_MS = 300;

const MANUAL_REVIEW_RESPONSE = {
  status: "manual_review",
  topic: null,
  draft: null,
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function parseAndValidateModelOutput(rawOutput) {
  if (typeof rawOutput !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const { topic, draft } = parsed;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) {
    return null;
  }
  if (typeof draft !== "string" || draft.trim().length === 0) {
    return null;
  }

  return {
    topic,
    draft: draft.trim(),
  };
}

async function callClassifierWithTimeout(text, classifier = classify, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  let timerId;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new Error("AI request timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      classifier(text, { signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timerId);
  }
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createTriageServer({ classifier = classify, timeoutMs = AI_TIMEOUT_MS } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }

    let payload;
    try {
      payload = await readRequestJson(request);
    } catch {
      return json(response, 400, { status: "invalid_input" });
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.text !== "string" ||
      payload.text.trim().length === 0
    ) {
      return json(response, 400, { status: "invalid_input" });
    }

    try {
      const rawModelOutput = await callClassifierWithTimeout(
        payload.text.trim(),
        classifier,
        timeoutMs,
      );
      const validResult = parseAndValidateModelOutput(rawModelOutput);

      if (!validResult) {
        return json(response, 200, MANUAL_REVIEW_RESPONSE);
      }

      return json(response, 200, {
        status: "ready",
        topic: validResult.topic,
        draft: validResult.draft,
      });
    } catch {
      return json(response, 200, MANUAL_REVIEW_RESPONSE);
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1");
}
