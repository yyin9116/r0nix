import { useEffect, useRef, useState } from "react";
import { Bold, Code, FilePlus, Italic, Link, Save } from "lucide-react";
import * as api from "../services/pdfApi";
import { markdownCache } from "../App";
import "./MarkdownEditor.css";

interface MarkdownEditorProps {
  fileId?: string;
}

function MarkdownEditor({ fileId }: MarkdownEditorProps) {
  const [content, setContent] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [wordCount, setWordCount] = useState(0);
  const [readTime, setReadTime] = useState(0);
  const [isNewFile, setIsNewFile] = useState(false);
  const [currentFileId, setCurrentFileId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("untitled");
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (fileId && fileId !== currentFileId) {
      setCurrentFileId(fileId);
      if (markdownCache.has(fileId)) {
        setContent(markdownCache.get(fileId) || "");
      } else {
        void loadMarkdown(fileId);
      }
    }
  }, [fileId, currentFileId]);

  useEffect(() => {
    if (currentFileId && content) {
      markdownCache.set(currentFileId, content);
    }

    if (!content) {
      setPreviewHtml("");
      setWordCount(0);
      setReadTime(0);
      return;
    }

    const timer = window.setTimeout(() => {
      void updatePreview();
      updateStats();
    }, 500);

    return () => clearTimeout(timer);
  }, [content, currentFileId]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, []);

  const showNotice = (text: string, ms = 2800) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice("");
      noticeTimerRef.current = null;
    }, ms);
  };

  const loadMarkdown = async (id: string) => {
    try {
      const result = await api.getMarkdownContent(id);
      setContent(result.content);
      markdownCache.set(id, result.content);
      setWordCount(result.wordCount);
      setReadTime(result.readTime);
      setIsNewFile(false);
    } catch (error) {
      console.error("Failed to load markdown:", error);
      setContent("");
      setIsNewFile(false);
    }
  };

  const updatePreview = async () => {
    try {
      const result = await api.previewMarkdown(content);
      setPreviewHtml(result.html);
    } catch (error) {
      console.error("Failed to preview markdown:", error);
    }
  };

  const updateStats = () => {
    const words = content.split(/\s+/).filter((w) => w.length > 0).length;
    setWordCount(words);
    setReadTime(Math.max(1, Math.floor(words / 200)));
  };

  const handleSave = async () => {
    if (!fileId && !isNewFile) return;

    if (isNewFile) {
      setNewFileName((prev) => prev.trim() || "untitled");
      setNameDialogOpen(true);
      return;
    }

    if (!fileId) return;
    try {
      await api.saveMarkdown(fileId, content);
      showNotice("Saved successfully!");
    } catch (error) {
      console.error("Failed to save markdown:", error);
      showNotice(`Failed to save: ${error}`);
    }
  };

  const saveNewFile = async () => {
    const trimmed = newFileName.trim();
    if (!trimmed) {
      showNotice("Please enter a filename");
      return;
    }
    const safeName = trimmed.replace(/[\\/:*?"<>|]/g, "_");
    try {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setNameDialogOpen(false);
      showNotice("File downloaded. Open it to continue editing.");
    } catch (error) {
      console.error("Failed to save new file:", error);
      showNotice(`Failed to save: ${error}`);
    }
  };

  const handleNewFile = () => {
    setIsNewFile(true);
    setContent("# New Document\n\nStart writing here...");
    setPreviewHtml("");
    setCurrentFileId(undefined);
    setNewFileName("untitled");
  };

  const insertFormatting = (before: string, after = "") => {
    const textarea = document.querySelector(".editor-textarea") as HTMLTextAreaElement | null;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);
    const newText = content.substring(0, start) + before + selectedText + after + content.substring(end);

    setContent(newText);

    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, end + before.length);
    }, 0);
  };

  if (!fileId && !isNewFile) {
    return (
      <div className="markdown-editor">
        <div className="markdown-empty-state">
          <Code size={64} color="#A1A1AA" />
          <p>No Markdown file opened</p>
          <p className="empty-hint">Click "Open" to select a file or "New" to create one</p>
          <button className="btn-new-file" onClick={handleNewFile}>
            <FilePlus size={20} />
            <span>New Markdown File</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="markdown-editor">
      <div className="editor-panel">
        <div className="editor-toolbar">
          <button className="editor-btn" title="New File" onClick={handleNewFile}>
            <FilePlus size={16} />
          </button>

          <div className="toolbar-divider" />

          <button className="editor-btn" title="Bold" onClick={() => insertFormatting("**", "**")}>
            <Bold size={16} />
          </button>
          <button className="editor-btn" title="Italic" onClick={() => insertFormatting("*", "*")}>
            <Italic size={16} />
          </button>
          <button className="editor-btn" title="Link" onClick={() => insertFormatting("[", "](url)")}>
            <Link size={16} />
          </button>
          <button className="editor-btn" title="Code" onClick={() => insertFormatting("`", "`")}>
            <Code size={16} />
          </button>

          <div className="editor-stats">
            {wordCount} words · {readTime} min read
          </div>

          <button className="btn-save" onClick={() => void handleSave()}>
            <Save size={16} />
            <span>Save</span>
          </button>
        </div>

        <textarea
          className="editor-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Start writing..."
          spellCheck={false}
        />
      </div>

      <div className="preview-panel">
        {previewHtml ? (
          <div className="preview-content" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        ) : (
          <div className="preview-empty">
            <p>Preview will appear here</p>
          </div>
        )}
      </div>

      {notice && <div className="markdown-notice">{notice}</div>}

      {nameDialogOpen && (
        <div className="markdown-dialog-backdrop" onMouseDown={() => setNameDialogOpen(false)}>
          <div className="markdown-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="markdown-dialog-title">Save markdown file</div>
            <input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="filename"
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveNewFile();
                if (e.key === "Escape") setNameDialogOpen(false);
              }}
              autoFocus
            />
            <div className="markdown-dialog-actions">
              <button type="button" onClick={() => setNameDialogOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={() => void saveNewFile()}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MarkdownEditor;
