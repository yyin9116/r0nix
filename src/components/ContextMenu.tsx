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
      data-reader-context-menu=""
      style={{ top: adjustedY, left: adjustedX }}
      className="fixed z-[120] w-64 bg-surface-panel/95 backdrop-blur-xl border border-border-subtle/80 shadow-2xl rounded-xl overflow-hidden font-sans text-[13px] text-content-primary"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="p-1.5 flex flex-col gap-0.5">
        <div className="px-2 py-1.5 text-[11px] font-semibold text-content-muted uppercase tracking-wider flex items-center justify-between">
          <span>{title || "Actions"}</span>
          <button className="p-1 rounded hover:bg-surface-hover text-content-muted" onClick={onClose} title="Close">
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
            className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-surface-hover rounded-md transition-colors text-left group disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2.5 text-content-secondary group-hover:text-content-primary">
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
  onExportImageCrop?: () => void;
  onExportSvg?: () => void;
  onClose: () => void;
  labels?: {
    copyPageReference: string;
    addNoteHere: string;
    exportCurrentPng: string;
    exportCurrentSvg?: string;
    exportImagePng?: string;
    exportImageCropPng?: string;
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
  if (options.imageTarget && options.onExportImageCrop) {
    actions.push({
      id: "export-image-crop-png",
      label: options.labels?.exportImageCropPng || "Export image crop PNG",
      icon: <FileImage size={14} />,
      onSelect: options.onExportImageCrop,
    });
  }
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
