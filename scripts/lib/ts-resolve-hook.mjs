import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 让 `node --experimental-strip-types` 能加载前端源码。
 *
 * 前端的相对 import 不带扩展名（`./localStore`），Vite 解析得了，
 * Node 不行。已有测试（assistHistory）是在 import 处显式写 `.ts` 绕开的，
 * 但 userSettings 依赖了一串模块，逐个加扩展名不现实 —— 那是把 Vite 的写法
 * 迁就 Node，而不是让测试真的能跑。
 *
 * 这里只补扩展名解析，不做任何类型变换；类型擦除由 --experimental-strip-types 负责。
 */

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".mjs", ".js"];

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对路径与工作区别名，绝对 URL 和裸包名交给 Node 正常解析。
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    if (base.protocol === "file:") {
      for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = new URL(base.href + suffix);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

export { pathToFileURL };
