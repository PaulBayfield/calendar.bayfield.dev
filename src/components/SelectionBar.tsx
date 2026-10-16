import { useSettings } from "../lib/settings";
import { Copy, CopyPlus, Scissors, Trash, X } from "./icons";

interface Props {
  count: number;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/** Floating bar shown while several events are selected. */
export function SelectionBar({ count, onCopy, onCut, onDuplicate, onDelete, onClear }: Props) {
  const { t } = useSettings();
  return (
    <div className="selection-bar" role="toolbar">
      <span className="selection-count">{t("nSelected", { n: count })}</span>
      <button className="icon-button" title={`${t("cut")} (Ctrl X)`} onClick={onCut}>
        <Scissors />
      </button>
      <button className="icon-button" title={`${t("copy")} (Ctrl C)`} onClick={onCopy}>
        <Copy />
      </button>
      <button className="icon-button" title={`${t("duplicate")} (Ctrl D)`} onClick={onDuplicate}>
        <CopyPlus />
      </button>
      <button className="icon-button danger" title={`${t("delete")} (${t("deleteKey")})`} onClick={onDelete}>
        <Trash />
      </button>
      <span className="selection-divider" />
      <button className="icon-button" title={`${t("close")} (Esc)`} onClick={onClear}>
        <X />
      </button>
    </div>
  );
}
