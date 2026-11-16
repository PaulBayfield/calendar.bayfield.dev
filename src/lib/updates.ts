// The app's version, and whether a newer one is out (from the GitHub releases).

import { useCallback, useEffect, useState } from "react";
import { version } from "../../package.json";
import { isTauri } from "./auth";
import type { Translate } from "./i18n";

export const APP_VERSION: string = version;

const REPO = "PaulBayfield/calendar.bayfield.dev";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** Desktop: how often to look for a new version while the app stays open. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface Release {
  version: string;
  /** The release page, with its notes. */
  url: string;
  /** The Windows installer, when the release has one. */
  installer: string | null;
}

/** 1 if `a` is newer than `b`, -1 if older, 0 if the same ("v0.10.0" > "0.9.1"). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The latest published release (drafts and pre-releases don't count). */
export async function latestRelease(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`Couldn't check for updates (${res.status})`);
  const json = (await res.json()) as { tag_name: string; html_url: string; assets?: { name: string; browser_download_url: string }[] };
  const installer = json.assets?.find((a) => /-setup\.exe$/i.test(a.name)) ?? json.assets?.find((a) => /\.msi$/i.test(a.name));
  return { version: json.tag_name.replace(/^v/, ""), url: json.html_url, installer: installer?.browser_download_url ?? null };
}

export type UpdateState = { status: "idle" | "checking" | "upToDate" | "error"; release?: undefined } | { status: "available"; release: Release };

/**
 * Looks for a newer version: on desktop at launch and every few hours, anywhere when `check`
 * is called. (The web app is updated with the server, so it only checks when asked.)
 */
export function useUpdateCheck(auto = isTauri) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const check = useCallback(async () => {
    setState((s) => (s.status === "available" ? s : { status: "checking" }));
    try {
      const release = await latestRelease();
      setState(compareVersions(release.version, APP_VERSION) > 0 ? { status: "available", release } : { status: "upToDate" });
    } catch {
      setState((s) => (s.status === "available" ? s : { status: "error" }));
    }
  }, []);
  useEffect(() => {
    if (!auto) return;
    // Not right at launch: the app has more important things to load first.
    const first = setTimeout(() => void check(), 5000);
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [auto, check]);
  return { state, check };
}

export type InstallState =
  | { status: "idle" | "installing" | "error" }
  /** `progress` is 0–1, or null while the size isn't known yet. */
  | { status: "downloading"; progress: number | null };

/** Desktop only: whether the update can be installed from inside the app. */
export const canInstallUpdates = isTauri;

/**
 * Desktop: downloads the signed update, installs it over the current version (same folder,
 * so shortcuts and the taskbar pin stay) and restarts. On Windows the installer closes the
 * app itself and opens it again when it's done.
 */
export function useInstallUpdate() {
  const [state, setState] = useState<InstallState>({ status: "idle" });
  const install = useCallback(async () => {
    setState({ status: "downloading", progress: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) throw new Error("No update found");
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          received += e.data.chunkLength;
          setState({ status: "downloading", progress: total ? Math.min(received / total, 1) : null });
        } else setState({ status: "installing" });
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      console.error("Update failed", e);
      setState({ status: "error" });
    }
  }, []);
  return { state, install };
}

/** What to show while installing (or after it failed); null when nothing is happening. */
export function installStatus(t: Translate, s: InstallState): string | null {
  switch (s.status) {
    case "downloading":
      return t("downloadingUpdate", { percent: s.progress === null ? "" : `${Math.round(s.progress * 100)}%` });
    case "installing":
      return t("installingUpdate");
    case "error":
      return t("updateInstallFailed");
    default:
      return null;
  }
}
