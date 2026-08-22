import React, { useEffect } from "react";
import { Download, FileCode2, FileImage, X, MessageSquarePlus, Copy } from "lucide-react";

export interface ContextMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  title?: string;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function ContextMenu({ x, y, isOpen, title, actions, onClose }: ContextMenuProps) {
  const adjustedX = Math.min(x, window.innerWidth - 260);
  const adjustedY = Math.min(y, window.innerHeight - 320);

  useEffect(() => {
    if (!isOpen) return;
    const handleGlobalClick = () => onClose();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handleGlobalClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleGlobalClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{ top: adjustedY, left: adjustedX }}
      className="fixed z-[120] w-64 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl border border-zinc-200/80 dark:border-zinc-800/80 shadow-2xl rounded-xl overflow-hidden font-sans text-[13px] text-zinc-800 dark:text-zinc-200"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="p-1.5 flex flex-col gap-0.5">
        <div className="px-2 py-1.5 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider flex items-center justify-between">
          <span>{title || "Actions"}</span>
          <button className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 dark:text-zinc-500" onClick={onClose} title="Close">
            <X size={12} />
          </button>
        </div>

        {actions.map((action) => (
          <button
            key={action.id}
            onClick={() => {
              if (action.disabled) return;
              action.onSelect();
              onClose();
            }}
            disabled={action.disabled}
            className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors text-left group disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2.5 text-zinc-700 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-zinc-100">
              {action.icon || <Download size={14} />}
              <span className="font-medium">{action.label}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function buildViewerContextActions(options: {
  onCopyPageLabel: () => void;
  onAddNote: () => void;
  onExportPng: () => void;
  onExportSvg?: () => void;
  onClose: () => void;
  labels?: {
    copyPageReference: string;
    addNoteHere: string;
    exportCurrentPng: string;
    exportCurrentSvg?: string;
    exportImagePng?: string;
    exportImageSvg?: string;
    cancel: string;
  };
  imageTarget?: boolean;
}): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [
    {
      id: "copy-page",
      label: options.labels?.copyPageReference || "Copy page reference",
      icon: <Copy size={14} />,
      onSelect: options.onCopyPageLabel,
    },
    {
      id: "add-note",
      label: options.labels?.addNoteHere || "Add note here",
      icon: <MessageSquarePlus size={14} />,
      onSelect: options.onAddNote,
    },
    {
      id: "export-png",
      label: options.imageTarget
        ? options.labels?.exportImagePng || "Export this PNG"
        : options.labels?.exportCurrentPng || "Export current page PNG",
      icon: <FileImage size={14} />,
      onSelect: options.onExportPng,
    },
  ];
  if (options.onExportSvg) {
    actions.push({
      id: "export-svg",
      label: options.imageTarget
        ? options.labels?.exportImageSvg || "Export this SVG"
        : options.labels?.exportCurrentSvg || "Export current page SVG",
      icon: <FileCode2 size={14} />,
      onSelect: options.onExportSvg,
    });
  }
  actions.push({
      id: "close",
      label: options.labels?.cancel || "Cancel",
      icon: <X size={14} />,
      onSelect: options.onClose,
    });
  return actions;
}
