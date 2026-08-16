import type { Config } from "../config.js";
import type { ConvertInput, Credentials, PayoutInput } from "../domain.js";
import { UpstreamError } from "../domain.js";
import type { Logger } from "../logger.js";
import { signBody, stableJson } from "./signing.js";
import { VERSION } from "../version.js";

interface ApiEnvelope<T> {
  state: number;
  result?: T;
  error_code?: string;
  errors?: unknown;
  message?: string;
}

type KeyType = "api" | "payout" | "public";
const MAX_UPSTREAM_RESPONSE_BYTES = 5 * 1_024 * 1_024;

async function readJsonBody(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new UpstreamError("2328 API response is too large", 502, "UPSTREAM_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    total += chunk.value.byteLength;
    if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UpstreamError("2328 API response is too large", 502, "UPSTREAM_RESPONSE_TOO_LARGE");
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export interface InvoiceInput {
  amount: string;
  currency: string;
  order_id: string;
  description?: string;
  network?: string;
  to_currency?: string;
  url_callback: string;
  url_return?: string;
  url_success?: string;
  invite_code?: string;
  fee_split?: string;
  price_markup?: string;
  ttl_seconds?: number;
}

export interface StaticWalletInput {
  currency: string;
  network: string;
  order_id: string;
  url_callback: string;
  label?: string;
  invite_code?: string;
}

export class Payments2328Client {
  public constructor(
    private readonly config: Config,
    private readonly credentials: Credentials,
    private readonly logger: Logger,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public balances(): Promise<unknown> {
    return this.request("GET", "/balance", undefined, "api", true);
  }

  public directions(): Promise<unknown> {
    return this.request("GET", "/directions", undefined, "api", true);
  }

  public exchangeRates(): Promise<unknown> {
    return this.request("GET", "/exchange-rates", undefined, "public", true);
  }

  public prices(): Promise<unknown> {
    return this.request("GET", "/prices", undefined, "public", true);
  }

  public createInvoice(input: InvoiceInput): Promise<unknown> {
    return this.request("POST", "/payment", input, "api", true);
  }

  public invoice(input: { uuid?: string; order_id?: string }): Promise<unknown> {
    return this.request("POST", "/payment/info", input, "api", true);
  }

  public invoices(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/payment/list", input, "api", true);
  }

  public quotePayout(input: Omit<PayoutInput, "order_id" | "url_callback">): Promise<unknown> {
    return this.request("POST", "/payout/calc", input, "payout", true);
  }

  public createPayout(input: PayoutInput): Promise<unknown> {
    return this.request("POST", "/payout", input, "payout", true);
  }

  public payout(uuid: string): Promise<unknown> {
    return this.request("GET", `/payout/status/${encodeURIComponent(uuid)}`, undefined, "payout", true);
  }

  public createStaticWallet(input: StaticWalletInput): Promise<unknown> {
    return this.request("POST", "/static-wallet", input, "api", true);
  }

  public staticWallet(input: { uuid?: string; address?: string }): Promise<unknown> {
    return this.request("POST", "/static-wallet/info", input, "api", true);
  }

  public staticWallets(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/static-wallet/list", input, "api", true);
  }

  public staticWalletTransactions(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/static-wallet/transactions", input, "api", true);
  }

  public enableStaticWallet(uuid: string): Promise<unknown> {
    return this.request("POST", "/static-wallet/enable", { uuid }, "api", true);
  }

  public disableStaticWallet(uuid: string): Promise<unknown> {
    return this.request("POST", "/static-wallet/disable", { uuid }, "api", true);
  }

  public quoteConvert(input: ConvertInput): Promise<unknown> {
    return this.request("POST", "/convert/price", input, "api", true);
  }

  public executeConvert(input: ConvertInput): Promise<unknown> {
    return this.request("POST", "/convert", input, "api", false);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    keyType: KeyType,
    retryable: boolean,
  ): Promise<unknown> {
    const key = keyType === "payout" ? this.credentials.payoutApiKey : this.credentials.apiKey;
    if (keyType !== "public" && !key) {
      throw new UpstreamError("This connection has no payout API key", 403, "PAYOUT_KEY_REQUIRED");
    }

    const body = payload === undefined ? "" : stableJson(payload);
    const url = new URL(`${this.config.API_BASE_URL.replace(/\/$/u, "")}${path}`);
    const attempts = retryable ? 3 : 1;
    let lastError: UpstreamError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.API_TIMEOUT_MS);
      timeout.unref();

      try {
        const headers: Record<string, string> = {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `2328-wallet-cli/${VERSION} (+https://doc.2328.io)`,
        };
        if (keyType !== "public") {
          if (!key) throw new UpstreamError("This connection has no payout API key", 403, "PAYOUT_KEY_REQUIRED");
          headers.project = this.credentials.projectId;
          headers.sign = signBody(body, key);
        }

        const response = await this.fetchImplementation(url, {
          method,
          headers,
          ...(method === "POST" ? { body } : {}),
          signal: controller.signal,
        });

        const responseValue = await readJsonBody(response);
        const responseBody = responseValue && typeof responseValue === "object" && !Array.isArray(responseValue)
          ? responseValue as ApiEnvelope<unknown>
          : undefined;
        if (!response.ok || responseBody?.state === 1) {
          const code = responseBody?.error_code ?? `HTTP_${String(response.status)}`;
          const upstreamError = new UpstreamError(
            responseBody?.message ?? "2328 API rejected the request",
            response.status,
            code,
            responseBody?.errors,
          );
          if (attempt < attempts && [429, 502, 503, 504].includes(response.status)) {
            lastError = upstreamError;
            await this.backoff(attempt, response.headers.get("retry-after"));
            continue;
          }
          this.logger.warn({ status: response.status, code, path }, "2328 API request failed");
          throw upstreamError;
        }

        if (responseValue === undefined) {
          throw new UpstreamError("2328 API returned an invalid response", 502, "INVALID_UPSTREAM_RESPONSE");
        }

        return responseBody?.result ?? responseValue;
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        const upstreamError = error instanceof Error && error.name === "AbortError"
          ? new UpstreamError("2328 API timed out", 504, "UPSTREAM_TIMEOUT")
          : new UpstreamError("2328 API is unavailable", 502, "UPSTREAM_UNAVAILABLE");
        if (attempt < attempts) {
          lastError = upstreamError;
          await this.backoff(attempt);
          continue;
        }
        throw upstreamError;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new UpstreamError("2328 API is unavailable", 502, "UPSTREAM_UNAVAILABLE");
  }

  private async backoff(attempt: number, retryAfter: string | null = null): Promise<void> {
    const retryAfterSeconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : 0;
    const delay = retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1_000, 2_000)
      : 200 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
    await Bun.sleep(delay);
  }
}
