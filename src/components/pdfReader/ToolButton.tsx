/**
 * PDFViewer 工具栏里的单颗图标按钮。
 * 从 PDFViewer.tsx 拆出（原 5485-5509 行）—— 它在主体里被引用了 10 次以上，
 * 单独放一个文件后，改按钮样式不必在 3600 行的主体里定位。
 */
import type { ReactNode } from "react";

export function ToolButton({
  icon,
  active,
  onClick,
  title,
}: {
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-1.5 rounded transition-all ${
        active
          ?"bg-surface-panel dark:bg-surface-active text-content-primary shadow-sm"
          :"text-content-secondary hover:text-content-primary hover:bg-surface-active/50"
      }`}
      title={title}
    >
      {icon}
    </button>
  );
}
