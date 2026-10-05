import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";

const settings = view(readFileSync("src/components/Settings.tsx", "utf8"));
const app = view(readFileSync("src/App.tsx", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pickDirectoryStart = settings.indexOf("const handlePickDirectory = async");
const pickDirectoryEnd = settings.indexOf("\n  const addQuickLink", pickDirectoryStart);
const pickDirectory = settings.slice(pickDirectoryStart, pickDirectoryEnd);
assert(pickDirectoryStart >= 0 && pickDirectoryEnd > pickDirectoryStart, "directory picker handler must remain explicit");
assert(pickDirectory.includes("try {") && pickDirectory.includes("catch (error)"), "settings directory picker must handle dialog failures");
assert(pickDirectory.includes("setDirectoryError"), "settings directory picker failures must be visible");

const importFolderStart = app.indexOf("const importFolder = useCallback");
const importFolderEnd = app.indexOf("\n  const handleCloseTab", importFolderStart);
const importFolder = app.slice(importFolderStart, importFolderEnd);
assert(importFolderStart >= 0 && importFolderEnd > importFolderStart, "folder import handler must remain explicit");
assert(importFolder.includes("try {") && importFolder.includes("catch (error)"), "folder import must handle dialog and scan failures");

// 打开失败必须**分类后**再显示，不能直接甩原始串。
// 原始 errno 说清的是「哪一层失败了」（PDF.js / Rust io::Error / TCC），
// 而用户需要的是「下一步做什么」。这两件事不是同一句，混在一起等于没提示 ——
// §13 记的那次「无声失败」其实是「有声但不可行动」，一样等于没有。
// 分类与文案在 services/fileOpenError.ts（纯函数、有单测）。
for (const raw of ["Failed to open file:", "打开 PDF 失败"]) {
  assert(
    !app.includes(raw),
    `open failures must be described by fileOpenError, not by the raw template "${raw}"`,
  );
}

// ★ 用**计数比对**而不是 includes()：只认「出现过」的话，三处调用里写死一处语言
// 守卫仍然是绿的（另外两处还在）。这是本仓第 5 次踩到同一类坑 ——
// 字符串守卫证明不了「每一处都这样」，只能证明「至少有一处这样」。
const described = app.split("describeFileOpenError(").length - 1;
const localized = app.split("describeFileOpenError(error, settings.language)").length - 1;
assert(described > 0, "open failures must be described by fileOpenError");
assert(
  described === localized,
  `every describeFileOpenError call must pass settings.language (${localized}/${described})`,
);

console.log("dialog-error-contract: ok");
