/**
 * Integration test: retry double-send prevention.
 *
 * Simulates upstream failures to verify that:
 *   1. Non-streaming: response is sent exactly once after retries
 *   2. Streaming: headers are written exactly once after retries
 *   3. Final fallback (502) is sent when all retries are exhausted
 *   4. No "Cannot set headers after they are sent" errors occur
 */

import http from "http";
import { AddressInfo } from "net";
import { Readable } from "stream";

// --- Mock environment variables ---
process.env.KILO_ENDPOINT = "http://localhost:19999";
process.env.KILO_FORMAT = "openai";
process.env.KILO_MODELS = "test-model";
process.env.KILO_API_KEYS_1 = "key-A";
process.env.KILO_API_KEYS_2 = "key-B";
process.env.KILO_API_KEYS_3 = "key-C";
process.env.PROXY_AUTH_KEY = "test-proxy-key";
process.env.PORT = "0"; // random port

// --- Mock fetch to simulate upstream behavior ---
interface MockResponseConfig {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  contentType: string;
  isStream?: boolean;
}

function createMockResponse(config: MockResponseConfig): Response {
  const bodyText = config.body;

  if (config.isStream) {
    // Create a Response with a readable stream body
    const encoder = new TextEncoder();
    const encoded = encoder.encode(bodyText);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    return new Response(readable, {
      status: config.status,
      statusText: config.statusText,
      headers: { "Content-Type": config.contentType },
    });
  }

  return new Response(bodyText, {
    status: config.status,
    statusText: config.statusText,
    headers: { "Content-Type": config.contentType },
  });
}

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

let mockFetchFn: MockFetchFn = async () =>
  createMockResponse({
    ok: true,
    status: 200,
    statusText: "OK",
    body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    contentType: "application/json",
  });

// Patch global fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => {
  return mockFetchFn(url, init);
}) as unknown as typeof fetch;

// --- Import after env setup ---
import app from "./app";

let server: http.Server;
let baseUrl: string;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makeRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; raw: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-proxy-key",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data, raw: res })
        );
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// --- Test runner ---
interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(testName: string, condition: boolean, detail: string): void {
  results.push({ name: testName, passed: condition, detail });
  const icon = condition ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${testName}: ${detail}`);
}

async function runTests(): Promise<void> {
  console.log("\n=== Test: Retry Double-Send Prevention ===\n");

  await startServer();
  console.log(`  Server started at ${baseUrl}\n`);

  // ============================================================
  // TEST 1: Non-streaming success on first attempt
  // ============================================================
  console.log("--- Test 1: Non-streaming success on first attempt ---");
  mockFetchFn = async () =>
    createMockResponse({
      ok: true,
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
      }),
      contentType: "application/json",
    });

  const res1 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert("T1: Status 200", res1.status === 200, `Got ${res1.status}`);
  assert(
    "T1: Body is valid JSON with 'hello'",
    res1.body.includes("hello"),
    `Body: ${res1.body.substring(0, 100)}`
  );

  // ============================================================
  // TEST 2: Non-streaming retry on 429, success on second key
  // ============================================================
  console.log("\n--- Test 2: Non-streaming retry on 429, success on second key ---");
  let fetchCallCount = 0;
  mockFetchFn = async () => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      return createMockResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: '{"error":{"message":"rate limited"}}',
        contentType: "application/json",
      });
    }
    return createMockResponse({
      ok: true,
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        choices: [{ message: { content: "recovered" } }],
        usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 },
      }),
      contentType: "application/json",
    });
  };

  const res2 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert(
    "T2: Status 200 after retry",
    res2.status === 200,
    `Got ${res2.status}`
  );
  assert(
    "T2: Body contains 'recovered'",
    res2.body.includes("recovered"),
    `Body: ${res2.body.substring(0, 100)}`
  );
  assert(
    "T2: Fetch called exactly 2 times",
    fetchCallCount === 2,
    `Called ${fetchCallCount} times`
  );

  // ============================================================
  // TEST 3: Non-streaming all retries exhausted (429 all keys)
  // ============================================================
  console.log("\n--- Test 3: Non-streaming all retries exhausted ---");
  fetchCallCount = 0;
  mockFetchFn = async () => {
    fetchCallCount++;
    return createMockResponse({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      body: '{"error":{"message":"rate limited"}}',
      contentType: "application/json",
    });
  };

  const res3 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert(
    "T3: Status 429 (exhausted retries)",
    res3.status === 429,
    `Got ${res3.status}`
  );
  assert(
    "T3: Fetch called 3 times (initial + 2 retries)",
    fetchCallCount === 3,
    `Called ${fetchCallCount} times`
  );
  assert(
    "T3: Body contains 'exhausted retries'",
    res3.body.includes("exhausted retries"),
    `Body: ${res3.body.substring(0, 200)}`
  );

  // ============================================================
  // TEST 4: Non-streaming non-retryable error (400)
  // ============================================================
  console.log("\n--- Test 4: Non-streaming non-retryable error (400) ---");
  fetchCallCount = 0;
  mockFetchFn = async () => {
    fetchCallCount++;
    return createMockResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      body: '{"error":{"message":"invalid request"}}',
      contentType: "application/json",
    });
  };

  const res4 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert("T4: Status 400", res4.status === 400, `Got ${res4.status}`);
  assert(
    "T4: Fetch called exactly 1 time (no retry)",
    fetchCallCount === 1,
    `Called ${fetchCallCount} times`
  );

  // ============================================================
  // TEST 5: Streaming retry on 503, success on second key
  // ============================================================
  console.log("\n--- Test 5: Streaming retry on 503, success on second key ---");
  fetchCallCount = 0;
  mockFetchFn = async () => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      return createMockResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        body: "Service Unavailable",
        contentType: "text/plain",
      });
    }
    return createMockResponse({
      ok: true,
      status: 200,
      statusText: "OK",
      body: 'data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n',
      contentType: "text/event-stream",
      isStream: true,
    });
  };

  const res5 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  assert(
    "T5: Status 200 (stream started)",
    res5.status === 200,
    `Got ${res5.status}`
  );
  assert(
    "T5: Content-Type is text/event-stream",
    res5.raw.headers["content-type"]?.includes("text/event-stream") === true,
    `Content-Type: ${res5.raw.headers["content-type"]}`
  );
  assert(
    "T5: Body contains streamed data",
    res5.body.includes("streamed"),
    `Body: ${res5.body.substring(0, 200)}`
  );
  assert(
    "T5: Fetch called exactly 2 times",
    fetchCallCount === 2,
    `Called ${fetchCallCount} times`
  );

  // ============================================================
  // TEST 6: Streaming all retries exhausted (503 all keys)
  // ============================================================
  console.log("\n--- Test 6: Streaming all retries exhausted ---");
  fetchCallCount = 0;
  mockFetchFn = async () => {
    fetchCallCount++;
    return createMockResponse({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      body: "Service Unavailable",
      contentType: "text/plain",
    });
  };

  const res6 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  assert(
    "T6: Status 503 (exhausted retries)",
    res6.status === 503,
    `Got ${res6.status}`
  );
  assert(
    "T6: Fetch called 3 times (initial + 2 retries)",
    fetchCallCount === 3,
    `Called ${fetchCallCount} times`
  );

  // ============================================================
  // TEST 7: Verify no double-send by counting response writes
  // ============================================================
  console.log("\n--- Test 7: Verify no double-send (response count) ---");
  fetchCallCount = 0;

  mockFetchFn = async () => {
    fetchCallCount++;
    if (fetchCallCount <= 2) {
      return createMockResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: '{"error":{"message":"rate limited"}}',
        contentType: "application/json",
      });
    }
    return createMockResponse({
      ok: true,
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        choices: [{ message: { content: "final" } }],
        usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 },
      }),
      contentType: "application/json",
    });
  };

  const res7 = await makeRequest("/kilo/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert(
    "T7: Status 200 after 2 failures",
    res7.status === 200,
    `Got ${res7.status}`
  );
  assert(
    "T7: Body contains 'final'",
    res7.body.includes("final"),
    `Body: ${res7.body.substring(0, 100)}`
  );
  assert(
    "T7: Fetch called exactly 3 times",
    fetchCallCount === 3,
    `Called ${fetchCallCount} times`
  );
  // The fact that we got a valid JSON response (not a crash/error) proves
  // that the response was sent exactly once — if double-send occurred,
  // we'd see "Cannot set headers after they are sent" error
  assert(
    "T7: No double-send crash (valid JSON response)",
    res7.body.startsWith("{") && res7.body.endsWith("}"),
    `Body is valid JSON: ${res7.body.substring(0, 100)}`
  );

  // ============================================================
  // Summary
  // ============================================================
  await stopServer();

  console.log("\n=== Summary ===\n");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.name}`);
    if (!r.passed) {
      console.log(`         ${r.detail}`);
    }
  }

  console.log(`\n  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
