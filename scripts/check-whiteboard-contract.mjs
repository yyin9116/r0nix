import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const canvas = fs.readFileSync(path.join(root, "src/components/WhiteboardCanvas.tsx"), "utf8");
const host = fs.readFileSync(path.join(root, "src/components/Whiteboards.tsx"), "utf8");
const paletteSource = fs.readFileSync(path.join(root, "src/theme/boardPalette.ts"), "utf8");
// 色板的头部注释要解释「哪些颜色被收敛掉了、为什么」，所以断言必须只看代码。
const palette = paletteSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function assert(condition, message) {
  if (!condition) throw new Error(`whiteboard-contract: ${message}`);
}

assert(canvas.includes('from "@xyflow/react"'), "whiteboard must use the maintained React Flow dependency");
assert(canvas.includes("ReactFlowProvider") && canvas.includes("Background") && canvas.includes("MiniMap"), "whiteboard must retain the library canvas primitives");
assert(canvas.includes('type: "group"') && canvas.includes("board.groups.map"), "persisted groups must render as React Flow nodes");
assert(canvas.includes("board.groups, documents, language"), "React Flow nodes must resync when persisted groups change");
assert(canvas.includes('change.type === "remove"') && canvas.includes("removedNodeIds") && canvas.includes("connections: previous.connections.filter"), "React Flow node deletion must persist and remove connected edges");
assert(canvas.includes("const duplicate = board.connections.some") && canvas.includes("if (duplicate) return"), "duplicate React Flow connections must be rejected before local state changes");
assert(host.includes("window.confirm(t.clearBoardConfirm)") && host.includes("window.confirm(t.seedBoardConfirm)"), "destructive whiteboard reset actions must require confirmation");
assert(!host.includes('className="hidden') && !host.includes("buildConnectionPath"), "old hidden hand-written canvas code must not return");
assert(!host.includes("window.addEventListener(\"pointermove\""), "whiteboard must not install global hand-written pointer tracking");

// 署名合规（2026-10-04）：React Flow 的 Attribution 徽标必须保持可见。
// 依据：依赖内 Attribution 组件的 data-message 明写「Please only hide this attribution
// when you are subscribed to React Flow Pro」—— 隐藏它是一个需要订阅的请求，
// 不是 MIT 许可要求（MIT 不带署名义务）。故显式写 false，并留下会变红的守卫。
assert(
  canvas.includes("hideAttribution: false"),
  "React Flow attribution must stay visible — hiding it requires a Pro subscription, so the decision must be explicit in code",
);

// 调色板收敛（2026-10-04）：五色 → zinc + blue。实测依据见 docs/design-system.md §3.6。
assert(canvas.includes("BOARD_PALETTE[card.color]") && canvas.includes("BOARD_PALETTE[data.group.color]"), "canvas colour must still come from the shared palette module");
assert(palette.includes('type CardColor = "zinc" | "blue"'), "the card palette must stay collapsed to zinc + blue (one neutral scale + one accent)");
assert(!/"(stone|slate|olive)"/.test(palette), "removed non-zinc neutral scales must not be reintroduced into the palette");
assert(palette.includes("export function normalizeCardColor"), "palette values must have a single normalizer exported next to the palette");
assert(host.includes("normalizeCardColor("), "whiteboard colour reads must go through the shared normalizer");
assert(!host.includes("normalizeColor("), "the whiteboard must not keep a second local colour normalizer");
assert(!/color:\s*"(stone|slate|olive)"/.test(host), "seeded and default cards must not assign a removed palette colour");
assert(!/color(Stone|Slate|Olive):/.test(host), "labels for removed palette colours must not linger in i18n");

console.log("whiteboard-contract: ok");
