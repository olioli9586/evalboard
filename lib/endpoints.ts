import { ENDPOINT_PREFIX } from "./eval";

// ---------------------------------------------------------------------------
// Custom HTTP endpoint models: a self-hosted classifier run through the same
// eval as the Claude models, so the two show up side by side. Endpoints are
// server config only, in EVALBOARD_ENDPOINTS:
//
//   {"tunebench-modernbert": {"url": "https://x.hf.space/predict", "output_field": "intent"}}
//
// A run names one as `endpoint:<name>` and never passes a URL. This is a
// public deployment: a URL taken from a request would let anyone make the
// server POST to any address, internal ones included (SSRF).
// ---------------------------------------------------------------------------

export interface Endpoint {
  url: string;
  outputField: string; // the response field that holds the answer
  usdPer1k: number; // price per 1,000 calls, for the cost column
}

// One request per case, so this bounds how long a case can wait on an answer.
export const ENDPOINT_TIMEOUT_MS = 30_000;

// Names become part of model ids, which are stored on runs and shown in the UI.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEYS = ["url", "output_field", "usd_per_1k"];

export class EndpointConfigError extends Error {
  constructor(message: string) {
    super(`EVALBOARD_ENDPOINTS: ${message}`);
    this.name = "EndpointConfigError";
  }
}

// Strict on purpose. A misspelled key would otherwise fall back to its default
// and every case would fail for no visible reason, and an endpoint skipped for
// a bad URL would just be missing from the list. The messages name the
// endpoint and the field but never the URL: they reach the browser.
export function parseEndpoints(raw: string | undefined): Map<string, Endpoint> {
  const endpoints = new Map<string, Endpoint>();
  if (!raw?.trim()) return endpoints;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EndpointConfigError("not valid JSON.");
  }
  if (!isObject(parsed)) {
    throw new EndpointConfigError('must be a JSON object of name -> {"url": ...}.');
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!NAME.test(name)) {
      throw new EndpointConfigError(
        `${JSON.stringify(name.slice(0, 80))} is not a valid name (letters, digits, ".", "_" and "-", up to 64 characters).`,
      );
    }
    if (!isObject(value)) throw new EndpointConfigError(`"${name}" must be an object.`);
    const unknown = Object.keys(value).find((k) => !KEYS.includes(k));
    if (unknown !== undefined) {
      throw new EndpointConfigError(
        `"${name}" has an unknown key ${JSON.stringify(unknown.slice(0, 80))} (allowed: ${KEYS.join(", ")}).`,
      );
    }
    const { url, output_field = "output", usd_per_1k = 0 } = value;
    if (typeof url !== "string" || !isHttpUrl(url)) {
      throw new EndpointConfigError(`"${name}".url must be an http or https URL, without a user name or password.`);
    }
    if (typeof output_field !== "string" || !output_field) {
      throw new EndpointConfigError(`"${name}".output_field must be a non-empty string.`);
    }
    if (typeof usd_per_1k !== "number" || !Number.isFinite(usd_per_1k) || usd_per_1k < 0) {
      throw new EndpointConfigError(`"${name}".usd_per_1k must be a number, 0 or more.`);
    }
    endpoints.set(name, { url, outputField: output_field, usdPer1k: usd_per_1k });
  }
  return endpoints;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// fetch refuses a URL with credentials in it, so that is a config error too.
function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Read at call time, like the limits in lib/limits.ts, so tests can set the
// variable per case. Throws EndpointConfigError on a bad config.
export function configuredEndpoints(): Map<string, Endpoint> {
  return parseEndpoints(process.env.EVALBOARD_ENDPOINTS);
}

// The configured endpoints as model ids, in config order.
export function endpointModels(): string[] {
  return [...configuredEndpoints().keys()].map((name) => ENDPOINT_PREFIX + name);
}

// The endpoint behind an `endpoint:<name>` model id, if that name is configured.
export function findEndpoint(model: string): Endpoint | undefined {
  if (!model.startsWith(ENDPOINT_PREFIX)) return undefined;
  return configuredEndpoints().get(model.slice(ENDPOINT_PREFIX.length));
}

// Why an endpoint call failed: an error status, no answer at all (refused,
// reset, unknown host), no answer in time, or an answer with no usable output.
// lib/retry.ts decides which of these are worth another try. The messages end
// up on public share pages, so they never include the URL or host.
export type EndpointFailure = "status" | "connection" | "timeout" | "response";

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly failure: EndpointFailure,
    readonly status?: number,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

// POSTs one case as {"text", "system"} and returns the answer in the
// endpoint's output field. A server that only needs the text ignores the
// system prompt (FastAPI drops unknown JSON fields). Redirects are not
// followed: the configured URL is the one that gets called.
export async function callEndpoint(
  endpoint: Endpoint,
  body: { text: string; system: string },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? ENDPOINT_TIMEOUT_MS;
  let res: Response;
  let text: string;
  try {
    res = await (opts.fetch ?? fetch)(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if ((err as { name?: unknown })?.name === "TimeoutError") {
      throw new EndpointError(`endpoint did not answer within ${timeoutMs / 1000} s`, "timeout");
    }
    // fetch's own message is just "fetch failed"; the cause's code (such as
    // ECONNREFUSED) says why without naming the host.
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    const why = typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` (${code})` : "";
    throw new EndpointError(`could not reach the endpoint${why}`, "connection");
  }
  if (!res.ok) {
    const redirect = res.status >= 300 && res.status < 400 ? " (redirects are not followed)" : "";
    throw new EndpointError(`endpoint answered ${res.status}${redirect}`, "status", res.status, res.headers);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new EndpointError("endpoint's response is not JSON", "response");
  }
  const output = isObject(data) ? data[endpoint.outputField] : undefined;
  if (typeof output !== "string") {
    throw new EndpointError(`endpoint's response has no string "${endpoint.outputField}" field`, "response");
  }
  return output;
}
