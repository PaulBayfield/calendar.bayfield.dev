// The app's version, and whether a newer one is out (from the GitHub releases).

import { useCallback, useEffect, useState } from "react";
import { version } from "../../package.json";
import { isTauri } from "./auth";

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
