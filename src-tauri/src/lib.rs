//! Google OAuth for the desktop build.
//!
//! Sign-in uses the installed-app flow: a loopback redirect on a random port plus PKCE.
//! The refresh token lives in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux); the webview only ever sees short-lived
//! access tokens.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
// Contacts scopes (read-only) power email autocompletion for guests.
const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly";
const KEYRING_SERVICE: &str = "dev.bayfield.calendar";
const KEYRING_USER: &str = "google-refresh-token";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
struct AccessToken {
    access_token: String,
    /// Unix seconds.
    expires_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

impl TokenError {
    fn message(self) -> String {
        self.error_description.unwrap_or(self.error)
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_b64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(err)
}

/// POSTs to Google's token endpoint. The outer error is a transport failure; the inner
/// one is an OAuth error response (e.g. `invalid_grant` for a revoked refresh token).
async fn request_token(params: &[(&str, &str)]) -> Result<Result<TokenResponse, TokenError>, String> {
    let res = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(params)
        .send()
        .await
        .map_err(err)?;
    let status = res.status();
    let body = res.text().await.map_err(err)?;
    if status.is_success() {
        return serde_json::from_str::<TokenResponse>(&body).map(Ok).map_err(err);
    }
    Ok(Err(serde_json::from_str::<TokenError>(&body).unwrap_or(TokenError {
        error: status.to_string(),
        error_description: Some(body),
    })))
}

/// Blocks until Google redirects the browser back to the loopback listener.
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(err)?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = handle_redirect(stream, expected_state) {
                    return result;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("Sign-in timed out".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(err(e)),
        }
    }
}

/// Returns `None` for unrelated requests (e.g. `/favicon.ico`) so we keep listening.
fn handle_redirect(mut stream: TcpStream, expected_state: &str) -> Option<Result<String, String>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let path = line.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };

    let result = if let Some(error) = param("error") {
        Err(format!("Google sign-in failed: {error}"))
    } else if let Some(code) = param("code") {
        if param("state").as_deref() == Some(expected_state) {
            Ok(code)
        } else {
            Err("Sign-in state mismatch".into())
        }
    } else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    };

    let message = if result.is_ok() {
        "You're signed in. You can close this tab and return to Calendar."
    } else {
        "Sign-in failed. You can close this tab and try again."
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Calendar</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;color:#37352f\">\
         <p>{message}</p>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    Some(result)
}

#[tauri::command]
async fn google_sign_in(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<AccessToken, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr().map_err(err)?.port());
    let verifier = random_b64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    let auth_url = url::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(err)?;
    app.opener().open_url(auth_url.as_str(), None::<&str>).map_err(err)?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state))
        .await
        .map_err(err)??;

    let token = request_token(&[
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", verifier.as_str()),
    ])
    .await?
    .map_err(|e| format!("Token exchange failed: {}", e.message()))?;

    if let Some(refresh_token) = &token.refresh_token {
        keyring_entry()?.set_password(refresh_token).map_err(err)?;
    }
    Ok(AccessToken {
        access_token: token.access_token,
        expires_at: now_secs() + token.expires_in,
    })
}

/// Mints a fresh access token from the stored refresh token. `None` means signed out.
#[tauri::command]
async fn google_access_token(
    client_id: String,
    client_secret: String,
) -> Result<Option<AccessToken>, String> {
    let entry = keyring_entry()?;
    let refresh_token = match entry.get_password() {
        Ok(token) => token,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(err(e)),
    };

    match request_token(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
    ])
    .await?
    {
        Ok(token) => Ok(Some(AccessToken {
            access_token: token.access_token,
            expires_at: now_secs() + token.expires_in,
        })),
        Err(e) if e.error == "invalid_grant" => {
            let _ = entry.delete_credential();
            Ok(None)
        }
        Err(e) => Err(format!("Couldn't refresh Google session: {}", e.message())),
    }
}

#[tauri::command]
async fn google_sign_out() -> Result<(), String> {
    let entry = keyring_entry()?;
    if let Ok(refresh_token) = entry.get_password() {
        let _ = reqwest::Client::new()
            .post(REVOKE_URL)
            .form(&[("token", refresh_token.as_str())])
            .send()
            .await;
    }
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            google_sign_in,
            google_access_token,
            google_sign_out
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
