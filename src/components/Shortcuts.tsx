import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import { PanelHeader } from "./PanelHeader";

const SHORTCUTS: [keys: string[], label: StringKey][] = [
  [["Ctrl", "K"], "scSearch"],
  [["T"], "scToday"],
  [["J", "K"], "scNav"],
  [["⇧", "Scroll"], "scScroll"],
  [["1–9", "0"], "scDays"],
  [["W"], "scWeek"],
  [["C"], "scNew"],
  [["Ctrl", "Clic"], "scMultiSelect"],
  [["Ctrl", "Z", "Y"], "scUndo"],
  [["Ctrl", "X", "C", "V"], "scClipboard"],
  [["Ctrl", "D"], "scDuplicate"],
  [["Ctrl", "B"], "scSidebar"],
  [["."], "scPanel"],
  [["H"], "scPrivacy"],
  [["Ctrl", ","], "settings"],
  [["Esc"], "scClose"],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const { t } = useSettings();
  return (
    <>
      <PanelHeader label={t("shortcuts")} onClose={onClose} />
      <div className="panel-body">
        <div className="shortcut-list">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} className="shortcut">
              <span>{t(label)}</span>
              <span className="keys">
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
