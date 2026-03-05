import { useEffect, useRef } from "react";
import { Copy, Image as ImageIcon } from "../icons";
import "./ContextMenu.css";

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDownload: (format?: string) => void;
  onCopy: () => void;
  type: 'image' | 'page' | 'selection';
  data?: any;
}

function ContextMenu({
  x,
  y,
  onClose,
  onDownload,
  onCopy,
  type,
  data,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent, action: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header Info */}
      {type === 'image' && data?.imageInfo && (
        <div className="context-menu-header">
          <ImageIcon size={14} />
          <span>
            {data.imageInfo.width} × {data.imageInfo.height}
            {data.imageInfo.extension && <span style={{ opacity: 0.7, marginLeft: 4 }}>• {data.imageInfo.extension.toUpperCase()}</span>}
          </span>
        </div>
      )}
      {type === 'selection' && (
        <div className="context-menu-header">
          <span>Selected Area</span>
        </div>
      )}
      {type === 'page' && (
        <div className="context-menu-header">
          <span>Page {data?.pageNumber}</span>
        </div>
      )}

      <div className="context-menu-group">
        <div className="context-menu-label">Save as</div>

        {/* Selection / Page Export Options */}
        {(type === 'selection' || type === 'page') && (
          <>
           <button
             className="context-menu-item"
             onMouseDown={(e) => handleMouseDown(e, () => onDownload("svg"))}
           >
             <span className="format-badge">SVG</span>
             <span>Save as Vector SVG</span>
           </button>
           <button
             className="context-menu-item"
             onMouseDown={(e) => handleMouseDown(e, () => onDownload("png"))}
           >
             <span className="format-badge">PNG</span>
             <span>Save as PNG Image</span>
           </button>
          </>
        )}

        {/* Image Export Options */}
        {type === 'image' && (
          <>
            <button
              className="context-menu-item"
              onMouseDown={(e) => handleMouseDown(e, () => onDownload("png"))}
            >
              <span className="format-badge">PNG</span>
              <span>Save as PNG</span>
            </button>

            <button
              className="context-menu-item"
              onMouseDown={(e) => handleMouseDown(e, () => onDownload("jpg"))}
            >
              <span className="format-badge">JPG</span>
              <span>Save as JPG</span>
            </button>

            <button
              className="context-menu-item"
              onMouseDown={(e) => handleMouseDown(e, () => onDownload("svg"))}
            >
              <span className="format-badge">SVG</span>
              <span>Save as SVG</span>
            </button>

            <button
              className="context-menu-item"
              onMouseDown={(e) => handleMouseDown(e, () => onDownload("original"))}
            >
              <span className="format-badge">Raw</span>
              <span>Save Original</span>
            </button>
          </>
        )}
      </div>

      {type === 'image' && (
        <>
          <div className="context-menu-divider"></div>
          <button
            className="context-menu-item"
            onMouseDown={(e) => handleMouseDown(e, onCopy)}
          >
            <Copy size={16} />
            <span>Copy Image</span>
          </button>
        </>
      )}
    </div>
  );
}

export default ContextMenu;
