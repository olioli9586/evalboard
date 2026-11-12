import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  callEndpoint,
  endpointModels,
  EndpointConfigError,
  EndpointError,
  findEndpoint,
  parseEndpoints,
  type Endpoint,
} from "./endpoints";

function configError(raw: string): string {
  try {
    parseEndpoints(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(EndpointConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a config error");
}

describe("parseEndpoints", () => {
  it("reads each endpoint, with the defaults filled in", () => {
    const endpoints = parseEndpoints(
      JSON.stringify({
        "tunebench-modernbert": { url: "https://x.hf.space/predict", output_field: "intent", usd_per_1k: 0.5 },
        local: { url: "http://127.0.0.1:8000/predict" },
      }),
    );
    expect([...endpoints]).toEqual([
      ["tunebench-modernbert", { url: "https://x.hf.space/predict", outputField: "intent", usdPer1k: 0.5 }],
      ["local", { url: "http://127.0.0.1:8000/predict", outputField: "output", usdPer1k: 0 }],
    ]);
  });

  it("has no endpoints when the variable is unset, blank or an empty object", () => {
    for (const raw of [undefined, "", "  ", "{}"]) expect(parseEndpoints(raw).size).toBe(0);
  });

  it("refuses JSON that isn't an object of objects", () => {
    expect(configError("{nope")).toBe("EVALBOARD_ENDPOINTS: not valid JSON.");
    for (const raw of ["[]", "null", '"x"', "3"]) expect(configError(raw)).toMatch(/must be a JSON object/);
    expect(configError('{"a": "https://x.test"}')).toMatch(/"a" must be an object/);
    expect(configError('{"a": ["https://x.test"]}')).toMatch(/"a" must be an object/);
  });

  it("refuses names that wouldn't make a clean model id", () => {
    for (const name of ["", "has space", "a/b", "-lead", "__proto__", "x".repeat(65), "é"]) {
      expect(configError(JSON.stringify({ [name]: { url: "https://x.test" } }))).toMatch(/is not a valid name/);
    }
    expect(parseEndpoints(JSON.stringify({ "Model_v2.1-a": { url: "https://x.test" } })).size).toBe(1);
  });

  it("refuses unknown keys, so a typo can't fall back to a default", () => {
    expect(configError('{"a": {"url": "https://x.test", "outputField": "intent"}}')).toBe(
      'EVALBOARD_ENDPOINTS: "a" has an unknown key "outputField" (allowed: url, output_field, usd_per_1k).',
    );
  });

  it("takes only http and https URLs, without credentials", () => {
    for (const url of [undefined, 5, "", "x.hf.space/predict", "ftp://x.test", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@x.test"]) {
      expect(configError(JSON.stringify({ a: { url } }))).toMatch(/"a".url must be an http or https URL/);
    }
  });

  it("checks output_field and usd_per_1k", () => {
    for (const output_field of ["", 3, null]) {
      expect(configError(JSON.stringify({ a: { url: "https://x.test", output_field } }))).toMatch(/output_field must be/);
    }
    for (const usd_per_1k of [-1, "1", null]) {
      expect(configError(JSON.stringify({ a: { url: "https://x.test", usd_per_1k } }))).toMatch(/usd_per_1k must be/);
    }
  });

  it("never puts a URL in its messages, since they reach the browser", () => {
    expect(configError('{"a": {"url": "https://secret.internal/predict?token=abc", "extra": 1}}')).not.toContain("secret");
    expect(configError('{"a": {"url": "gopher://secret.internal"}}')).not.toContain("secret");
  });
});

describe("endpoints from the environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists configured endpoints as model ids and finds them by id", () => {
    vi.stubEnv("EVALBOARD_ENDPOINTS", '{"b": {"url": "https://b.test"}, "a": {"url": "https://a.test"}}');
    expect(endpointModels()).toEqual(["endpoint:b", "endpoint:a"]);
    expect(findEndpoint("endpoint:a")).toMatchObject({ url: "https://a.test" });
    expect(findEndpoint("endpoint:c")).toBeUndefined();
    expect(findEndpoint("a")).toBeUndefined();
    expect(findEndpoint("claude-haiku-5-5")).toBeUndefined();
  });

  it("has none when unset, and throws on a bad config instead of dropping it", () => {
    vi.stubEnv("EVALBOARD_ENDPOINTS", "");
    expect(endpointModels()).toEqual([]);
    vi.stubEnv("EVALBOARD_ENDPOINTS", '{"a": {"url": "ftp://a.test"}}');
    expect(() => endpointModels()).toThrow(EndpointConfigError);
    expect(() => findEndpoint("endpoint:a")).toThrow(EndpointConfigError);
  });
});

// A real local server, so the real fetch runs: headers, bodies, redirects,
// timeouts and refused connections all behave as they would in production.
describe("callEndpoint", () => {
  let handler: http.RequestListener = (_req, res) => res.end();
  let server: http.Server;
  let base: string;
  const at = (path: string, outputField = "output"): Endpoint => ({ url: base + path, outputField, usdPer1k: 0 });

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const failure = (p: Promise<unknown>) => p.then(() => expect.unreachable("expected a failure"), (e: unknown) => e as EndpointError);

  it("POSTs the case as JSON and returns the output field", async () => {
    const seen: { method?: string; type?: string; body?: unknown }[] = [];
    handler = (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, type: req.headers["content-type"], body: JSON.parse(body) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ intent: "card_arrival", confidence: 0.97, top: [] }));
      });
    };
    const out = await callEndpoint(at("/predict", "intent"), { text: "Where is my card?", system: "Classify." });
    expect(out).toBe("card_arrival");
    expect(seen).toEqual([
      { method: "POST", type: "application/json", body: { text: "Where is my card?", system: "Classify." } },
    ]);
  });

  it("reports an error status with its headers", async () => {
    handler = (_req, res) => res.writeHead(503, { "retry-after": "2" }).end("busy");
    const err = await failure(callEndpoint(at("/p"), { text: "x", system: "" }));
    expect(err).toBeInstanceOf(EndpointError);
    expect(err).toMatchObject({ failure: "status", status: 503, message: "endpoint answered 503" });
    expect(err.headers?.get("retry-after")).toBe("2");
  });

  it("does not follow a redirect", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      res.writeHead(307, { location: "/elsewhere" }).end();
    };
    const err = await failure(callEndpoint(at("/p"), { text: "x", system: "" }));
    expect(err).toMatchObject({ failure: "status", status: 307, message: "endpoint answered 307 (redirects are not followed)" });
    expect(calls).toBe(1);
  });

  it("rejects a body that isn't JSON, or has no string output field", async () => {
    handler = (_req, res) => res.end("<html>Space is sleeping</html>");
    expect(await failure(callEndpoint(at("/p"), { text: "x", system: "" }))).toMatchObject({
      failure: "response",
      message: "endpoint's response is not JSON",
    });
    for (const body of ['{"label": "card_arrival"}', '{"intent": 3}', '{"intent": null}', '["card_arrival"]', "null"]) {
      handler = (_req, res) => res.end(body);
      expect(await failure(callEndpoint(at("/p", "intent"), { text: "x", system: "" }))).toMatchObject({
        failure: "response",
        message: 'endpoint\'s response has no string "intent" field',
      });
    }
  });

  it("gives up on an endpoint that doesn't answer in time", async () => {
    handler = () => {}; // never answers
    const err = await failure(callEndpoint(at("/p"), { text: "x", system: "" }, { timeoutMs: 100 }));
    expect(err).toMatchObject({ failure: "timeout", message: "endpoint did not answer within 0.1 s" });
  });

  it("times out a body that stops halfway too", async () => {
    handler = (_req, res) => res.writeHead(200).write('{"output": "car');
    const err = await failure(callEndpoint(at("/p"), { text: "x", system: "" }, { timeoutMs: 100 }));
    expect(err).toMatchObject({ failure: "timeout" });
  });

  it("reports a refused connection by its code, without the address", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const err = await failure(
      callEndpoint({ url: `http://127.0.0.1:${port}/p`, outputField: "output", usdPer1k: 0 }, { text: "x", system: "" }),
    );
    expect(err).toMatchObject({ failure: "connection", message: "could not reach the endpoint (ECONNREFUSED)" });
    expect(err.message).not.toContain(String(port));
  });

  it("uses the fetch it is given", async () => {
    const fake = vi.fn().mockResolvedValue(new Response('{"output": " billing "}'));
    expect(await callEndpoint(at("/p"), { text: "x", system: "s" }, { fetch: fake })).toBe(" billing ");
    expect(fake.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "manual", body: '{"text":"x","system":"s"}' });
  });
});
