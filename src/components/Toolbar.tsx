import { useEffect, useRef, useState } from "react";
import type { ViewType } from "../App";
import {
  PanelLeft,
  Maximize,
  FileText,
  Pencil,
  Search,
  ZoomOut,
  ZoomIn,
  MoreHorizontal,
  Eye,
  Save,
} from "lucide-react";
import "./Toolbar.css";

interface ToolbarProps {
  currentView: ViewType;
  activeFile?: { name: string; meta?: string };
  onSwitchView: (view: ViewType) => void;
  onToggleSidebar: () => void;
  onToggleFullscreen: () => void;
  sidebarVisible: boolean;
}

function Toolbar({
  currentView,
  activeFile,
  onSwitchView,
  onToggleSidebar,
  onToggleFullscreen,
}: ToolbarProps) {
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, []);

  const showNotice = (text: string, ms = 2200) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice("");
      noticeTimerRef.current = null;
    }, ms);
  };

  return (
    <div className="toolbar">
      {/* Left Group */}
      <div className="toolbar-left">
        <button
          className="btn-icon"
          onClick={onToggleSidebar}
          title="Toggle Sidebar (Ctrl+B)"
        >
          <PanelLeft size={16} />
        </button>
        <button
          className="btn-icon"
          onClick={onToggleFullscreen}
          title="Fullscreen (F11)"
        >
          <Maximize size={16} />
        </button>

        {/* View Tabs */}
        <div className="view-tabs">
          <button
            className={`view-tab ${currentView === "pdf" ? "active" : ""}`}
            onClick={() => onSwitchView("pdf")}
          >
            <FileText size={14} />
            <span>PDF View</span>
          </button>
          <button
            className={`view-tab ${currentView === "markdown" ? "active" : ""}`}
            onClick={() => onSwitchView("markdown")}
          >
            <Pencil size={14} />
            <span>Markdown</span>
          </button>
        </div>
      </div>

      {/* Center */}
      <div className="toolbar-center">
        <div className="toolbar-center-stack">
          <span className="page-info">
            {activeFile ? activeFile.name : "No file selected"}
          </span>
          {notice && <span className="toolbar-notice">{notice}</span>}
        </div>
      </div>

      {/* Right Group */}
      <div className="toolbar-right">
        {currentView === "pdf" ? (
          <>
            <button
              className="btn-icon"
              title="Search"
              onClick={() => showNotice("Search is not implemented yet")}
            >
              <Search size={16} />
            </button>
            <button
              className="btn-icon"
              title="Zoom Out"
              onClick={() => window.dispatchEvent(new CustomEvent('app:zoom-out'))}
            >
              <ZoomOut size={16} />
            </button>
            <button
              className="btn-icon"
              title="Zoom In"
              onClick={() => window.dispatchEvent(new CustomEvent('app:zoom-in'))}
            >
              <ZoomIn size={16} />
            </button>
            <button
              className="btn-icon"
              title="More"
              onClick={() => showNotice("More options are not implemented yet")}
            >
              <MoreHorizontal size={16} />
            </button>
          </>
        ) : (
          <>
            <button
              className="btn-action"
              title="Toggle Preview"
              onClick={() => showNotice("Preview toggle is not implemented yet")}
            >
              <Eye size={14} />
              <span>Preview</span>
            </button>
            <button
              className="btn-action btn-primary"
              title="Save (Ctrl+S)"
              onClick={() => showNotice("Save is not implemented yet")}
            >
              <Save size={14} />
              <span>Save</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default Toolbar;
