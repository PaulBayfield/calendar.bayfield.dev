import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerPrefsDesktop } from "./lib/prefs";
import "./styles.css";

// Desktop app: the shared preferences use its Tauri functions (see lib/prefs.ts).
if ("__TAURI_INTERNALS__" in window) registerPrefsDesktop({ invoke, openUrl });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
