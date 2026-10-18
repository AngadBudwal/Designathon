import { describe, expect, it } from "vitest";

import { checkDevWriteAccess, jsonbTextBytes, readJsonBody } from "./request-guard";
import { DEV_ENV, postRequest } from "./testing/requests";

async function errorOf(response: Response | null) {
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() };
}

describe("checkDevWriteAccess", () => {
  it("allows a local request with the flag enabled", () => {
    expect(checkDevWriteAccess(postRequest({}), DEV_ENV)).toBeNull();
    expect(
      checkDevWriteAccess(postRequest({}, {}, "http://127.0.0.1:3000/api/analyses"), DEV_ENV),
    ).toBeNull();
  });

  it("allows same-origin and extension origins", () => {
    expect(checkDevWriteAccess(postRequest({}, { origin: "http://localhost:3000" }), DEV_ENV)).toBeNull();
    expect(
      checkDevWriteAccess(postRequest({}, { origin: "chrome-extension://abcdefghijklmnop" }), DEV_ENV),
    ).toBeNull();
  });

  it("disables writes in production even when the flag is set", async () => {
    const result = await errorOf(
      checkDevWriteAccess(postRequest({}), { ...DEV_ENV, NODE_ENV: "production" }),
    );
    expect(result).toEqual({
      status: 403,
      body: { error: { code: "forbidden", message: "Analysis writes are not enabled on this server." } },
    });
  });

  it.each([undefined, "false", "1", "TRUE"])("disables writes when the flag is %s", async (flag) => {
    const result = await errorOf(
      checkDevWriteAccess(postRequest({}), { ...DEV_ENV, ENABLE_DEV_ANALYSIS_WRITE: flag }),
    );
    expect(result.status).toBe(403);
  });

  it("disables writes when APP_BASE_URL is not a loopback address", async () => {
    const result = await errorOf(
      checkDevWriteAccess(postRequest({}), { ...DEV_ENV, APP_BASE_URL: "https://app.example.com" }),
    );
    expect(result.status).toBe(403);
  });

  it.each([
    ["a rebinding host", { host: "attacker.example.com:3000" }],
    ["another port", { host: "localhost:4000" }],
    ["a host with a path", { host: "localhost:3000/evil" }],
    ["a cross-site origin", { origin: "https://attacker.example.com" }],
    ["an opaque origin", { origin: "null" }],
    ["a different local port origin", { origin: "http://localhost:4000" }],
  ])("rejects %s", async (_name, headers) => {
    const result = await errorOf(checkDevWriteAccess(postRequest({}, headers), DEV_ENV));
    expect(result.status).toBe(403);
  });
});

describe("readJsonBody", () => {
  it("parses a JSON body", async () => {
    await expect(readJsonBody(postRequest({ a: 1 }))).resolves.toEqual({ ok: true, value: { a: 1 } });
  });

  it("requires application/json", async () => {
    const result = await readJsonBody(postRequest("{}", { "content-type": "text/plain" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(415);
  });

  it("rejects a declared length over the limit", async () => {
    const result = await readJsonBody(postRequest("{}", { "content-length": "70000" }), 64);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("rejects a streamed body over the limit without trusting Content-Length", async () => {
    const big = JSON.stringify({ text: "x".repeat(100) });
    const result = await readJsonBody(postRequest(big), 64);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("rejects malformed JSON", async () => {
    const result = await readJsonBody(postRequest("{not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await result.response.json()).error.code).toBe("validation_error");
    }
  });
});

describe("jsonbTextBytes", () => {
  it("counts the separators Postgres adds when printing jsonb", () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length);
  });
});
