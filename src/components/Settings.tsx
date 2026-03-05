import { useState, useEffect } from "react";
import { X, Folder } from "../icons";
import { open } from '@tauri-apps/plugin-dialog';
import "./Settings.css";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

function Settings({ isOpen, onClose }: SettingsProps) {
  const [downloadPath, setDownloadPath] = useState<string>("");

  useEffect(() => {
    // Load saved settings from localStorage
    const savedPath = localStorage.getItem("defaultDownloadPath");
    if (savedPath) {
      setDownloadPath(savedPath);
    }
  }, [isOpen]);

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Default Download Folder",
      });

      if (selected && typeof selected === 'string') {
        setDownloadPath(selected);
        localStorage.setItem("defaultDownloadPath", selected);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
    }
  };

  const handleClearPath = () => {
    setDownloadPath("");
    localStorage.removeItem("defaultDownloadPath");
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Download Settings</h3>

            <div className="settings-item">
              <label>Default Download Folder</label>
              <div className="settings-path-input">
                <input
                  type="text"
                  value={downloadPath}
                  placeholder="Not set - will prompt each time"
                  readOnly
                />
                <button className="btn-select-folder" onClick={handleSelectFolder}>
                  <Folder size={16} />
                  Select
                </button>
              </div>
              {downloadPath && (
                <button className="btn-clear-path" onClick={handleClearPath}>
                  Clear Default Path
                </button>
              )}
              <p className="settings-hint">
                When set, images will be saved to this folder by default
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
