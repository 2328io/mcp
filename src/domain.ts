export const SCOPES = [
  "wallet:read",
  "market:read",
  "invoice:read",
  "invoice:create",
  "static-wallet:read",
  "static-wallet:create",
  "static-wallet:update",
  "payout:read",
  "payout:quote",
  "payout:create",
  "convert:quote",
  "convert:execute",
] as const;

export type Scope = (typeof SCOPES)[number];

export interface Credentials {
  projectId: string;
  apiKey: string;
  payoutApiKey?: string;
}

export interface Principal {
  subject: string;
  scopes: ReadonlySet<Scope>;
  credentials: Credentials;
}

export interface PayoutInput {
  currency: string;
  network: string;
  amount: string;
  to_address: string;
  memo?: string;
  fee_option: "deduct" | "add";
  order_id: string;
  url_callback?: string;
  from_currency?: "USDT";
}

export interface ConvertInput {
  from_currency: string;
  to_currency: string;
  amount: string;
  amount_type: "from" | "to";
}

export function parseScopes(value: string): Scope[] {
  const requested = value.split(/\s+/u).filter(Boolean);
  const allowed = new Set<string>(SCOPES);

  if (requested.some((scope) => !allowed.has(scope))) {
    throw new Error("Unsupported OAuth scope");
  }

  return [...new Set(requested)] as Scope[];
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) {
    throw new AuthorizationError(`Missing required scope: ${scope}`);
  }
}

export class AuthorizationError extends Error {}

export class UpstreamError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
