// The app's own right-click menu outside events and the grid (which have theirs), in place of
// the browser's or WebView2's ("Inspect", "Reload"…). Shift + right-click opens the native one.

import type { AppMenuEntry } from "../components/ContextMenu";
import { CalendarIcon, ClipboardPaste, Compose, Copy, External, LinkIcon, Repeat, Scissors } from "../components/icons";
import type { StringKey } from "./i18n";
import { openExternal } from "./open";

interface Context {
  t: (key: StringKey) => string;
  onNewEvent: () => void;
  onToday: () => void;
}

const run = (field: HTMLElement, name: "cut" | "copy") => () => {
  field.focus();
  document.execCommand(name);
};

async function pasteInto(field: HTMLInputElement | HTMLTextAreaElement) {
  try {
    const text = await navigator.clipboard.readText();
    field.focus();
    document.execCommand("insertText", false, text);
  } catch {
    // Clipboard access refused.
  }
}

/** The menu for a right-click on `target`, or null to leave it to the native one. */
export function appMenuFor(target: Element, { t, onNewEvent, onToday }: Context): AppMenuEntry[] | null {
  const field = target.closest("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
  if (field && !["checkbox", "radio", "range", "color", "file", "button", "submit"].includes(field.type)) {
    const selected = field.selectionStart !== field.selectionEnd;
    const editable = !field.readOnly && !field.disabled;
    const entries: AppMenuEntry[] = [];
    if (editable) entries.push({ label: t("cut"), icon: <Scissors />, shortcut: "Ctrl X", disabled: !selected, onClick: run(field, "cut") });
    entries.push({ label: t("copy"), icon: <Copy />, shortcut: "Ctrl C", disabled: !selected, onClick: run(field, "copy") });
    if (editable) entries.push({ label: t("paste"), icon: <ClipboardPaste />, shortcut: "Ctrl V", onClick: () => void pasteInto(field) });
    entries.push("separator", { label: t("selectAll"), shortcut: "Ctrl A", onClick: () => (field.focus(), field.select()) });
    return entries;
  }

  const entries: AppMenuEntry[] = [];
  const href = target.closest("a[href]")?.getAttribute("href");
  if (href && /^(https?:|mailto:)/.test(href))
    entries.push(
      { label: t("openLink"), icon: <External />, onClick: () => openExternal(href) },
      { label: t("copyLinkAddress"), icon: <LinkIcon />, onClick: () => void navigator.clipboard.writeText(href) },
      "separator",
    );
  const text = window.getSelection()?.toString();
  if (text) entries.push({ label: t("copy"), icon: <Copy />, shortcut: "Ctrl C", onClick: () => void navigator.clipboard.writeText(text) }, "separator");
  entries.push(
    { label: t("newEvent"), icon: <Compose />, shortcut: "C", onClick: onNewEvent },
    { label: t("today"), icon: <CalendarIcon />, shortcut: "T", onClick: onToday },
    "separator",
    { label: t("reload"), icon: <Repeat />, onClick: () => location.reload() },
  );
  return entries;
}
