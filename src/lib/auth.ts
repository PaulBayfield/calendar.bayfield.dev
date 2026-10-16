// Google sign-in for both builds.
//  - Desktop (Tauri): the Rust side runs the OAuth flow and keeps the refresh token in the
//    OS credential store, so sessions survive restarts and refresh silently.
//  - Web: Google Identity Services token client. Tokens last an hour and can't be refreshed
//    without a click, so the web build asks you to reconnect when one expires.

import { invoke } from "@tauri-apps/api/core";
import { isDemo } from "./demo";

export const isTauri = "__TAURI_INTERNALS__" in window;

// Contacts scopes (read-only) power email autocompletion for guests.
const SCOPES = "openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly";
const WEB_TOKEN_KEY = "calendar.webToken";

interface Token {
  access_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Sign-in required");
  }
}

let token: Token | null = null;
let refreshing: Promise<Token | null> | null = null;

const isValid = (t: Token | null): t is Token => !!t && t.expires_at - 60 > Date.now() / 1000;

function desktopCredentials() {
  const clientId = import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Set VITE_GOOGLE_DESKTOP_CLIENT_ID and VITE_GOOGLE_DESKTOP_CLIENT_SECRET in .env.local");
  }
  return { clientId, clientSecret };
}

function readWebToken(): Token | null {
  try {
    const raw = sessionStorage.getItem(WEB_TOKEN_KEY);
    return raw ? (JSON.parse(raw) as Token) : null;
  } catch {
    return null;
  }
}

function writeWebToken(t: Token | null) {
  try {
    if (t) sessionStorage.setItem(WEB_TOKEN_KEY, JSON.stringify(t));
    else sessionStorage.removeItem(WEB_TOKEN_KEY);
  } catch {
    // Storage unavailable: the session just won't survive a reload.
  }
}

// --- Google Identity Services (web) ---

interface GisTokenResponse {
  access_token: string;
  expires_in: string | number;
  error?: string;
  error_description?: string;
}

interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: GisTokenResponse) => void;
        error_callback?: (error: { type: string; message?: string }) => void;
      }): { requestAccessToken(options?: { prompt?: string }): void };
      revoke(accessToken: string, done: () => void): void;
    };
  };
}

declare global {
  interface Window {
    google?: Gis;
  }
}

let gisLoading: Promise<Gis> | null = null;

/** Loads the GIS script. Call it early so the sign-in click can open the popup straight away. */
export function preloadSignIn(): Promise<Gis> | undefined {
  if (isTauri) return;
  gisLoading ??= new Promise<Gis>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve(window.google!);
    script.onerror = () => {
      gisLoading = null;
      reject(new Error("Couldn't load Google sign-in"));
    };
    document.head.appendChild(script);
  });
  return gisLoading;
}

async function webSignIn(): Promise<Token> {
  const clientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID;
  if (!clientId) throw new Error("Set VITE_GOOGLE_WEB_CLIENT_ID in .env.local");
  const gis = await preloadSignIn()!;
  return new Promise((resolve, reject) => {
    gis.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: (r) => {
          if (r.error) reject(new Error(r.error_description ?? r.error));
          else resolve({ access_token: r.access_token, expires_at: Date.now() / 1000 + Number(r.expires_in) });
        },
        error_callback: (e) => reject(new Error(e.message ?? e.type)),
      })
      .requestAccessToken({ prompt: "" });
  });
}

// --- Public API ---

/** Returns true if there's a usable session (desktop: stored refresh token; web: unexpired token). */
export async function restoreSession(): Promise<boolean> {
  if (isDemo) return true;
  if (!isTauri) {
    token = readWebToken();
    return isValid(token);
  }
  try {
    await getAccessToken();
    return true;
  } catch (e) {
    if (e instanceof AuthRequiredError) return false;
    throw e;
  }
}

export async function signIn(): Promise<void> {
  if (isTauri) {
    token = await invoke<Token>("google_sign_in", desktopCredentials());
  } else {
    token = await webSignIn();
    writeWebToken(token);
  }
}

export async function signOut(): Promise<void> {
  if (isTauri) await invoke("google_sign_out");
  else if (token) window.google?.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  writeWebToken(null);
}

/** Throws AuthRequiredError when the user has to sign in (again). */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (isDemo) return "demo";
  if (!forceRefresh && isValid(token)) return token.access_token;
  if (!isTauri) {
    token = null;
    writeWebToken(null);
    throw new AuthRequiredError();
  }
  refreshing ??= invoke<Token | null>("google_access_token", desktopCredentials()).finally(() => {
    refreshing = null;
  });
  const fresh = await refreshing;
  if (!fresh) throw new AuthRequiredError();
  token = fresh;
  return fresh.access_token;
}
