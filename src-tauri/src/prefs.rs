//! This computer's token for prefs.bayfield.dev (the preferences the bayfield.dev apps share), in
//! the OS credential store. One entry for every desktop app (the same file in each): connecting
//! one of them connects the others on this computer too.

const SERVICE: &str = "dev.bayfield.prefs";
const USER: &str = "device-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|e| e.to_string())
}

/// The token, or `None` before this computer was connected (or after disconnecting it).
#[tauri::command]
pub fn prefs_token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Saves the token, or forgets it with `None`.
#[tauri::command]
pub fn prefs_token_set(token: Option<String>) -> Result<(), String> {
    let entry = entry()?;
    match token {
        Some(t) => entry.set_password(&t).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// This computer's name, to tell it apart in prefs.bayfield.dev's list ("Notes on PAUL-PC").
#[tauri::command]
pub fn prefs_computer_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
}
