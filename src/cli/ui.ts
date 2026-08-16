import * as p from "@clack/prompts";
import Table from "cli-table3";
import pc from "picocolors";
import { Payments2328Client } from "../api/client.js";
import { loadConfig, type Config } from "../config.js";
import type { ConvertInput, Credentials, PayoutInput } from "../domain.js";
import { UpstreamError } from "../domain.js";
import { createLogger } from "../logger.js";
import { ProfileStore, type ResolvedProfile } from "./profiles.js";

interface ClientContext { client: Payments2328Client; config: Config; profile: ResolvedProfile }
const BACK = "__back";

function isCancelled(value: unknown): value is symbol {
  if (!p.isCancel(value)) return false;
  p.cancel("Operation cancelled");
  return true;
}

function required(value: string | undefined): string | undefined {
  return value?.trim() ? undefined : "Required";
}

function decimal(value: string | undefined): string | undefined {
  return value && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(value) && /[1-9]/u.test(value)
    ? undefined
    : "Use a positive decimal string, for example 200 or 0.01";
}

function httpUrl(value: string | undefined, optional = false): string | undefined {
  if (!value?.trim()) return optional ? undefined : "Required";
  try {
    return ["http:", "https:"].includes(new URL(value).protocol) ? undefined : "Use an HTTP or HTTPS URL";
  } catch {
    return "Use a valid URL";
  }
}

function percentage(value: string | undefined, minimum: number, maximum: number): string | undefined {
  if (!value?.trim()) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(value)) return `Use a decimal value from ${String(minimum)} to ${String(maximum)}`;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? undefined : `Use a value from ${String(minimum)} to ${String(maximum)}`;
}

function createContext(profile: ResolvedProfile): ClientContext {
  const config = loadConfig({
    ...process.env,
    TRANSPORT: "stdio",
    API_BASE_URL: profile.apiBaseUrl,
    PROJECT_ID: profile.credentials.projectId,
    API_KEY: profile.credentials.apiKey,
    PAYOUT_API_KEY: profile.credentials.payoutApiKey,
    LOG_LEVEL: "silent",
  });
  return {
    profile,
    config,
    client: new Payments2328Client(config, profile.credentials, createLogger(config)),
  };
}

function printable(value: unknown): string {
  const safe = displaySafe(value);
  if (typeof safe === "string") return safe;
  return JSON.stringify(safe, null, 2);
}

function displaySafe(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return `[QR data URI omitted · ${String(value.length)} characters]`;
    return value.length > 1_000 ? `${value.slice(0, 1_000)}… [${String(value.length - 1_000)} characters omitted]` : value;
  }
  if (depth >= 6) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const visible = value.slice(0, 50).map((item) => displaySafe(item, depth + 1));
    if (value.length > visible.length) visible.push(`[${String(value.length - visible.length)} more items omitted]`);
    return visible;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, displaySafe(item, depth + 1)]));
  }
  return value;
}

function showResult(title: string, value: unknown): void {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const items = Array.isArray(value) ? value : Array.isArray(record?.items) ? record.items : undefined;
  if (items && items.length > 0 && items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    const keys = [...new Set(items.flatMap((item) => Object.keys(item as Record<string, unknown>)))].slice(0, 7);
    const table = new Table({ head: keys.map((key) => pc.cyan(key)), wordWrap: true });
    for (const item of items.slice(0, 50)) {
      const row = item as Record<string, unknown>;
      table.push(keys.map((key) => printable(row[key] ?? "")));
    }
    p.note(table.toString(), title);
    return;
  }
  p.note(printable(value), title);
}

function showError(error: unknown): void {
  if (error instanceof UpstreamError) {
    p.log.error(`${error.message} [${error.code}]${error.details ? `\n${printable(error.details)}` : ""}`);
    return;
  }
  p.log.error(error instanceof Error ? error.message : "The operation failed");
}

async function run<T>(title: string, action: () => Promise<T>): Promise<T | undefined> {
  const spinner = p.spinner();
  spinner.start(title);
  try {
    const value = await action();
    spinner.stop(`${title}: done`);
    return value;
  } catch (error) {
    spinner.stop(`${title}: failed`);
    showError(error);
    return undefined;
  }
}

async function inputText(message: string, options: { placeholder?: string; initialValue?: string; validate?: (value: string | undefined) => string | undefined } = {}): Promise<string | null> {
  const value = await p.text({ message, ...options });
  return isCancelled(value) ? null : value;
}

async function inputOptional(message: string, placeholder?: string, validate?: (value: string | undefined) => string | undefined): Promise<string | null> {
  const value = await p.text({ message, ...(placeholder ? { placeholder } : {}), ...(validate ? { validate } : {}) });
  return isCancelled(value) ? null : value.trim();
}

async function paymentMenu(context: ClientContext): Promise<void> {
  let done = false;
  while (!done) {
    const action = await p.select({ message: "Payments", options: [
      { value: "create", label: "Create invoice" },
      { value: "get", label: "Find invoice" },
      { value: "list", label: "Recent invoices" },
      { value: BACK, label: "Back" },
    ] });
    if (isCancelled(action) || action === BACK) {
      done = true;
      continue;
    }
    if (action === "list") {
      const value = await run("Loading invoices", () => context.client.invoices({ page: 1, per_page: 20 }));
      if (value !== undefined) showResult("Invoices", value);
      continue;
    }
    if (action === "get") {
      const identifier = await inputText("Invoice UUID or order ID", { validate: required });
      if (!identifier) continue;
      const value = await run("Loading invoice", () => context.client.invoice(
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(identifier) ? { uuid: identifier } : { order_id: identifier },
      ));
      if (value !== undefined) showResult("Invoice", value);
      continue;
    }

    const amount = await inputText("Amount", { placeholder: "100.00", validate: decimal });
    if (!amount) continue;
    const currency = await inputText("Invoice currency", { placeholder: "USD", validate: required });
    if (!currency) continue;
    const orderId = await inputText("Unique order ID", { placeholder: `cli-${crypto.randomUUID()}`, validate: required });
    if (!orderId) continue;
    const callback = await inputText("Webhook callback URL", { placeholder: "https://merchant.example/webhooks/2328", validate: httpUrl });
    if (!callback) continue;
    const direct = await p.confirm({ message: "Preselect a cryptocurrency and network?", initialValue: false });
    if (isCancelled(direct)) continue;
    let toCurrency: string | null = null;
    let selectedNetwork: string | null = null;
    if (direct) {
      toCurrency = await inputText("Payer cryptocurrency", { placeholder: "USDT", validate: required });
      if (!toCurrency) continue;
      selectedNetwork = await inputText("Canonical network code", { placeholder: "TRX-TRC20", validate: required });
      if (!selectedNetwork) continue;
    }
    const advanced = await p.confirm({ message: "Configure optional invoice fields?", initialValue: false });
    if (isCancelled(advanced)) continue;
    let description: string | undefined;
    let returnUrl: string | undefined;
    let successUrl: string | undefined;
    let feeSplit: string | undefined;
    let priceMarkup: string | undefined;
    let ttlSeconds: number | undefined;
    if (advanced) {
      const descriptionValue = await inputOptional("Description", "Shown on the hosted payment page");
      if (descriptionValue === null) continue;
      description = descriptionValue || undefined;
      const returnValue = await inputOptional("Return URL", "https://merchant.example/orders/return", (value) => httpUrl(value, true));
      if (returnValue === null) continue;
      returnUrl = returnValue || undefined;
      const successValue = await inputOptional("Success URL", "https://merchant.example/orders/success", (value) => httpUrl(value, true));
      if (successValue === null) continue;
      successUrl = successValue || undefined;
      const feeValue = await p.text({
        message: "Payer fee share, percent (blank uses project setting)",
        validate: (value) => percentage(value, 0, 100),
      });
      if (isCancelled(feeValue)) continue;
      feeSplit = feeValue.trim() || undefined;
      const markupValue = await p.text({
        message: "Price markup/discount, percent (blank uses project setting)",
        validate: (value) => percentage(value, -99, 100),
      });
      if (isCancelled(markupValue)) continue;
      priceMarkup = markupValue.trim() || undefined;
      const ttlValue = await p.text({
        message: "Lifetime in seconds (blank uses project default)",
        validate: (value) => {
          if (!value?.trim()) return undefined;
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 300 && parsed <= 86_400 ? undefined : "Use an integer from 300 to 86400";
        },
      });
      if (isCancelled(ttlValue)) continue;
      ttlSeconds = ttlValue.trim() ? Number(ttlValue) : undefined;
    }
    const value = await run("Creating invoice", () => context.client.createInvoice({
      amount,
      currency: currency.toUpperCase(),
      order_id: orderId,
      url_callback: callback,
      ...(toCurrency ? { to_currency: toCurrency.toUpperCase() } : {}),
      ...(selectedNetwork ? { network: selectedNetwork } : {}),
      ...(description ? { description } : {}),
      ...(returnUrl ? { url_return: returnUrl } : {}),
      ...(successUrl ? { url_success: successUrl } : {}),
      ...(feeSplit ? { fee_split: feeSplit } : {}),
      ...(priceMarkup ? { price_markup: priceMarkup } : {}),
      ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
    }));
    if (value !== undefined) showResult("Invoice created", value);
  }
}

async function payoutMenu(context: ClientContext): Promise<void> {
  if (!context.profile.credentials.payoutApiKey) {
    p.log.warn("This profile has no payout API key. Add it by updating the profile.");
    return;
  }
  const action = await p.select({ message: "Payouts", options: [
    { value: "create", label: "Prepare and create payout" },
    { value: "status", label: "Check payout status" },
    { value: BACK, label: "Back" },
  ] });
  if (isCancelled(action) || action === BACK) return;
  if (action === "status") {
    const uuid = await inputText("Payout UUID", { validate: required });
    if (!uuid) return;
    const value = await run("Loading payout", () => context.client.payout(uuid));
    if (value !== undefined) showResult("Payout", value);
    return;
  }

  const amount = await inputText("Amount to send", { placeholder: "200", validate: decimal });
  if (!amount) return;
  const currency = await inputText("Asset", { placeholder: "USDT", validate: required });
  if (!currency) return;
  const selectedNetwork = await inputText("Canonical network code", { placeholder: "TRX-TRC20", validate: required });
  if (!selectedNetwork) return;
  const destination = await inputText("Destination address", { validate: required });
  if (!destination) return;
  const feeOption = await p.select({ message: "Fee handling", options: [
    { value: "deduct", label: "Deduct fee from amount" },
    { value: "add", label: "Add fee on top" },
  ] });
  if (isCancelled(feeOption)) return;
  const orderId = await inputText("Unique payout order ID", { initialValue: `cli-${crypto.randomUUID()}`, validate: required });
  if (!orderId) return;
  const memo = await inputOptional("Destination memo/tag", "Leave blank when the network does not require it");
  if (memo === null) return;
  const callback = await inputOptional("Payout callback URL", "Leave blank to disable payout webhooks", (value) => httpUrl(value, true));
  if (callback === null) return;
  const payout: PayoutInput = {
    amount,
    currency: currency.toUpperCase(),
    network: selectedNetwork,
    to_address: destination,
    fee_option: feeOption,
    order_id: orderId,
    ...(memo ? { memo } : {}),
    ...(callback ? { url_callback: callback } : {}),
  };
  const quote = await run("Calculating payout", () => context.client.quotePayout({
    amount: payout.amount,
    currency: payout.currency,
    network: payout.network,
    to_address: payout.to_address,
    fee_option: payout.fee_option,
  }));
  if (quote === undefined) return;
  showResult("Payout quote", { request: payout, quote });
  const phrase = `SEND ${payout.amount} ${payout.currency} ON ${payout.network} TO ${payout.to_address} FEE ${payout.fee_option}`;
  p.log.warn("This action moves funds and blockchain transfers may be irreversible.");
  const confirmation = await inputText(`Type exactly: ${phrase}`);
  if (confirmation !== phrase) {
    p.log.info("Payout was not created");
    return;
  }
  const result = await run("Creating payout", () => context.client.createPayout(payout));
  if (result !== undefined) showResult("Payout created", result);
}

async function convertMenu(context: ClientContext): Promise<void> {
  const fromCurrency = await inputText("Source asset", { placeholder: "USDT", validate: required });
  if (!fromCurrency) return;
  const toCurrency = await inputText("Target asset", { placeholder: "BTC", validate: required });
  if (!toCurrency) return;
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) {
    p.log.error("Source and target assets must differ");
    return;
  }
  const amountType = await p.select({ message: "Amount means", options: [
    { value: "from", label: `Spend source asset (${fromCurrency.toUpperCase()})` },
    { value: "to", label: `Receive target asset (${toCurrency.toUpperCase()})` },
  ] });
  if (isCancelled(amountType)) return;
  const amount = await inputText(amountType === "from" ? "Amount to spend" : "Amount to receive", { validate: decimal });
  if (!amount) return;
  const convert: ConvertInput = {
    from_currency: fromCurrency.toUpperCase(),
    to_currency: toCurrency.toUpperCase(),
    amount,
    amount_type: amountType,
  };
  const quote = await run("Getting conversion quote", () => context.client.quoteConvert(convert));
  if (quote === undefined) return;
  showResult("Indicative quote", quote);
  p.log.warn("The execution price can change. A timeout does not prove that the conversion failed.");
  const phrase = `CONVERT ${convert.amount} ${convert.amount_type === "from" ? convert.from_currency : convert.to_currency} FROM ${convert.from_currency} TO ${convert.to_currency}`;
  const confirmation = await inputText(`Type exactly: ${phrase}`);
  if (confirmation !== phrase) {
    p.log.info("Conversion was not executed");
    return;
  }
  const result = await run("Executing conversion", () => context.client.executeConvert(convert));
  if (result !== undefined) showResult("Conversion result", result);
}

async function staticWalletMenu(context: ClientContext): Promise<void> {
  const action = await p.select({ message: "Static wallets", options: [
    { value: "list", label: "List wallets" },
    { value: "get", label: "Find wallet" },
    { value: "create", label: "Create wallet" },
    { value: "transactions", label: "Wallet deposits" },
    { value: "enable", label: "Enable wallet" },
    { value: "disable", label: "Disable wallet" },
    { value: BACK, label: "Back" },
  ] });
  if (isCancelled(action) || action === BACK) return;
  if (action === "list") {
    const value = await run("Loading static wallets", () => context.client.staticWallets({ page: 1, per_page: 20 }));
    if (value !== undefined) showResult("Static wallets", value);
    return;
  }
  if (action === "create") {
    const currency = await inputText("Asset", { placeholder: "USDT", validate: required });
    if (!currency) return;
    const selectedNetwork = await inputText("Canonical network code", { placeholder: "TRX-TRC20", validate: required });
    if (!selectedNetwork) return;
    const orderId = await inputText("Stable customer/order ID", { validate: required });
    if (!orderId) return;
    const callback = await inputText("Webhook callback URL", { validate: httpUrl });
    if (!callback) return;
    const label = await inputOptional("Wallet label", "Optional");
    if (label === null) return;
    const value = await run("Creating static wallet", () => context.client.createStaticWallet({
      currency: currency.toUpperCase(), network: selectedNetwork, order_id: orderId, url_callback: callback,
      ...(label ? { label } : {}),
    }));
    if (value !== undefined) showResult("Static wallet", value);
    return;
  }
  const identifier = await inputText(action === "get" ? "Wallet UUID or address" : "Wallet UUID", { validate: required });
  if (!identifier) return;
  if (action === "get") {
    const value = await run("Loading static wallet", () => context.client.staticWallet(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(identifier) ? { uuid: identifier } : { address: identifier },
    ));
    if (value !== undefined) showResult("Static wallet", value);
  } else if (action === "transactions") {
    const value = await run("Loading deposits", () => context.client.staticWalletTransactions({ uuid: identifier, page: 1, per_page: 20 }));
    if (value !== undefined) showResult("Wallet deposits", value);
  } else if (action === "enable") {
    const value = await run("Enabling wallet", () => context.client.enableStaticWallet(identifier));
    if (value !== undefined) showResult("Static wallet enabled", value);
  } else {
    p.log.warn("Disabling does not erase the address or stop an already-sent blockchain transfer.");
    const confirmed = await p.confirm({ message: `Disable static wallet ${identifier}?`, initialValue: false });
    if (isCancelled(confirmed) || !confirmed) return;
    const value = await run("Disabling wallet", () => context.client.disableStaticWallet(identifier));
    if (value !== undefined) showResult("Static wallet disabled", value);
  }
}

async function addProfile(store: ProfileStore): Promise<ResolvedProfile | null> {
  const name = await inputText("Profile name", { placeholder: "default", validate: required });
  if (!name) return null;
  const projectId = await inputText("Project ID", { validate: required });
  if (!projectId) return null;
  const apiKeyValue = await p.password({ message: "Regular API key", validate: required });
  if (isCancelled(apiKeyValue)) return null;
  const addPayout = await p.confirm({ message: "Add a separate payout API key?", initialValue: false });
  if (isCancelled(addPayout)) return null;
  let payoutApiKey: string | undefined;
  if (addPayout) {
    const payoutValue = await p.password({ message: "Payout API key", validate: required });
    if (isCancelled(payoutValue)) return null;
    payoutApiKey = payoutValue;
  }
  const apiBaseUrl = "https://api.2328.io/api/v1";
  const credentials: Credentials = { projectId, apiKey: apiKeyValue, ...(payoutApiKey ? { payoutApiKey } : {}) };
  const provisional: ResolvedProfile = { name, apiBaseUrl, credentials, source: "profile" };
  const testResult = await run("Checking credentials", () => createContext(provisional).client.balances());
  if (testResult === undefined) {
    p.log.error("Profile was not saved because the credentials could not be verified");
    return null;
  }
  try {
    await store.save({ name, projectId, apiBaseUrl }, { apiKey: apiKeyValue, ...(payoutApiKey ? { payoutApiKey } : {}) });
  } catch (error) {
    showError(error);
    p.log.info("Use PROJECT_ID, API_KEY and optionally PAYOUT_API_KEY environment variables on systems without a credential store.");
    return null;
  }
  p.log.success(`Profile '${name}' saved in the operating system credential store`);
  return store.resolve(process.env, name);
}

async function chooseProfile(store: ProfileStore): Promise<ResolvedProfile | "empty" | null> {
  const profiles = await store.list();
  const action = await p.select({ message: "Profiles", options: [
    ...profiles.profiles.map((profile) => ({
      value: `use:${profile.name}`,
      label: profile.name,
      hint: `${profile.projectId}${profile.hasPayoutKey ? " · payouts enabled" : ""}${profile.name === profiles.currentProfile ? " · current" : ""}`,
    })),
    { value: "add", label: "Add or update profile" },
    ...(profiles.profiles.length > 0 ? [{ value: "remove", label: "Remove profile" }] : []),
    { value: BACK, label: "Back" },
  ] });
  if (isCancelled(action) || action === BACK) return null;
  if (action === "add") return addProfile(store);
  if (action === "remove") {
    const target = await p.select({
      message: "Profile to remove",
      options: profiles.profiles.map((profile) => ({ value: profile.name, label: profile.name, hint: profile.projectId })),
    });
    if (isCancelled(target)) return null;
    const confirmed = await p.confirm({ message: `Remove '${target}' metadata and stored keys?`, initialValue: false });
    if (isCancelled(confirmed) || !confirmed) return null;
    await store.remove(target);
    p.log.success(`Profile '${target}' removed`);
    return await store.resolve() ?? "empty";
  }
  const selected = action.slice(4);
  await store.use(selected);
  return store.resolve(process.env, selected);
}

export async function startInteractiveCli(store = new ProfileStore()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a terminal. Use --mcp for an MCP client or --help for usage.");
  }
  p.intro(pc.bgCyan(pc.black(" 2328 Wallet CLI ")));
  let profile = await store.resolve();
  if (!profile) {
    p.log.info("No account profile is configured. API keys will be stored by the operating system, not in the config file.");
    profile = await addProfile(store);
    if (!profile) {
      p.outro("No profile configured");
      return;
    }
  }

  let done = false;
  while (!done) {
    const context = createContext(profile);
    const action = await p.select({
      message: `Account: ${profile.name} (${profile.credentials.projectId})`,
      options: [
        { value: "balance", label: "Account overview" },
        { value: "payments", label: "Payments" },
        { value: "payouts", label: "Payouts" },
        { value: "static", label: "Static wallets" },
        { value: "convert", label: "Convert balance" },
        { value: "market", label: "Directions and market data" },
        { value: "profiles", label: "Switch or add profile" },
        { value: "exit", label: "Exit" },
      ],
    });
    if (isCancelled(action) || action === "exit") {
      done = true;
      continue;
    }
    try {
      if (action === "balance") {
        const value = await run("Loading balances", () => context.client.balances());
        if (value !== undefined) showResult("Balances", value);
      } else if (action === "payments") await paymentMenu(context);
      else if (action === "payouts") await payoutMenu(context);
      else if (action === "static") await staticWalletMenu(context);
      else if (action === "convert") await convertMenu(context);
      else if (action === "market") {
        const marketAction = await p.select({ message: "Market data", options: [
          { value: "directions", label: "Available directions" },
          { value: "rates", label: "Reference exchange rates" },
          { value: "prices", label: "Market prices" },
          { value: BACK, label: "Back" },
        ] });
        if (!isCancelled(marketAction) && marketAction !== BACK) {
          const value = await run("Loading market data", () => marketAction === "directions"
            ? context.client.directions()
            : marketAction === "rates" ? context.client.exchangeRates() : context.client.prices());
          if (value !== undefined) showResult("Market data", value);
        }
      } else {
        const selected = await chooseProfile(store);
        if (selected === "empty") {
          p.log.info("No profiles remain");
          done = true;
        } else if (selected) profile = selected;
      }
    } catch (error) {
      showError(error);
    }
  }
  p.outro("Session closed");
}
