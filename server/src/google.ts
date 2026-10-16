// Minimal Google OAuth + Calendar client for the server (owner's account only).

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/calendar/v3";
export const SCOPES = "openid email https://www.googleapis.com/auth/calendar";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class GoogleError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function authUrl(cfg: OAuthConfig, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(body.error_description ?? body.error ?? "Token request failed", res.status, body.error);
  return body;
}

export const exchangeCode = (cfg: OAuthConfig, code: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });

export const refreshAccessToken = (cfg: OAuthConfig, refreshToken: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

export interface TokenInfo {
  email?: string;
  email_verified?: string | boolean;
  azp?: string;
  aud?: string;
  expires_in?: string;
}

/** Validates an access token with Google; null if it's invalid or expired. */
export async function tokenInfo(accessToken: string): Promise<TokenInfo | null> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  return res.ok ? res.json() : null;
}

export async function calendarApi<T>(
  accessToken: string,
  path: string,
  { method = "GET", params = {}, body }: { method?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(json.error?.message ?? `Google Calendar error (${res.status})`, res.status);
  return json;
}

export interface Interval {
  start: number;
  end: number;
}

export async function freeBusy(accessToken: string, calendarIds: string[], timeMin: Date, timeMax: Date): Promise<Interval[]> {
  const res = await calendarApi<{ calendars: Record<string, { busy?: { start: string; end: string }[] }> }>(
    accessToken,
    "/freeBusy",
    {
      method: "POST",
      body: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: calendarIds.map((id) => ({ id })) },
    },
  );
  return Object.values(res.calendars).flatMap((c) =>
    (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
  );
}
