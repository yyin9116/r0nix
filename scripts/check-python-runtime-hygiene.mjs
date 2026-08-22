import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve("src-tauri/runtime");
const forbidden = [];

function visit(current) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        forbidden.push(fullPath);
        continue;
      }
      visit(fullPath);
    } else if (entry.name.endsWith(".pyc")) {
      forbidden.push(fullPath);
    }
  }
}

visit(root);
if (forbidden.length > 0) {
  throw new Error(`Embedded Python runtime contains bytecode cache files:\n${forbidden.join("\n")}`);
}

console.log("python-runtime-hygiene: ok");
