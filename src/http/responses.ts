export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(SECURITY_HEADERS);
  if (headers) for (const [name, value] of new Headers(headers)) responseHeaders.set(name, value);
  return Response.json(data, {
    status,
    headers: responseHeaders,
  });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

export async function readForm(request: Request, maximumBytes = 32_768): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new Error("Expected application/x-www-form-urlencoded");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maximumBytes) throw new Error("Request body is too large");
  const body = await request.text();
  if (Buffer.byteLength(body) > maximumBytes) throw new Error("Request body is too large");
  return new URLSearchParams(body);
}
