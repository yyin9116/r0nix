import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 命令注册闭合性检查。
 *
 * 类型检查看不出这类问题：前端 `invoke("workspace_info")` 里的命令名是**字符串**，
 * 后端 `generate_handler!` 里也是字符串，两边对不上时 tsc 全绿、运行时才报
 * "command not found"。工作区这次新增了 7 个命令，正好是最容易漏注册的地方。
 *
 * 检查方式：扫出前端所有 invoke 字面量，与 main.rs 注册表求差集。
 */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sources = walk("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
const mainRs = readFileSync("src-tauri/src/main.rs", "utf8");

// 注册表：invoke_handler 里的 r0nix::tauri_commands::<name>
const registered = new Set(
  [...mainRs.matchAll(/r0nix::tauri_commands::([a-z0-9_]+)/g)].map((match) => match[1])
);

// 前端 invoke 的字面量参数。三处调用点都要认：
//   invoke("x")            —— 直接调用
//   invoke('x')            —— 单引号
//   invokeNative("x")      —— nativeWebview / rustPdf 里的薄封装
// 只扫其中一种会让反向检查误报成「没人调用」，那样的守卫很快会被忽略掉。
// 仍然故意不认变量形式的调用：那个本来就无法静态核对，不该假装能查。
const invoked = new Map();
const CALLERS = /\b(?:invoke|invokeNative)(?:<[^>]*>)?\(\s*['"]([a-z0-9_]+)['"]/g;
for (const { path, text } of sources) {
  for (const match of text.matchAll(CALLERS)) {
    const list = invoked.get(match[1]) || [];
    list.push(path);
    invoked.set(match[1], list);
  }
}

const missing = [...invoked.keys()].filter((command) => !registered.has(command));
assert(
  missing.length === 0,
  `frontend invokes commands that are not registered in main.rs:\n  ${missing
    .map((command) => `${command}  ← ${[...new Set(invoked.get(command))].join(", ")}`)
    .join("\n  ")}`
);

// 反向：注册了却没人调用的命令通常是拼错的实现，不该悄悄留着。
// 两个已知例外：
// - app_data_dir 把宿主目录暴露给前端做诊断展示；
// - cleanup_stale_web_pdf_temp_files 在 main.rs 的 setup 里调用，不走 IPC。
const KNOWN_UNCALLED = new Set(["app_data_dir", "cleanup_stale_web_pdf_temp_files"]);
const uncalled = [...registered].filter(
  (command) => !invoked.has(command) && !KNOWN_UNCALLED.has(command)
);
assert(
  uncalled.length === 0,
  `registered commands that nothing invokes (dead or misnamed):\n  ${uncalled.join("\n  ")}`
);

console.log(`command-registry: ok（${invoked.size} 个前端调用全部已注册）`);
