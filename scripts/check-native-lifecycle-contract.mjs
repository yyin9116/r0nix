import { readFileSync } from "node:fs";

const commands = readFileSync("src-tauri/src/tauri_commands.rs", "utf8");
const tests = readFileSync("src-tauri/tests/tauri_commands.rs", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(commands.includes("pub async fn close_pdf_document"), "PDF handle closing must be independently testable");
assert(commands.includes("pub async fn close_pdf(app: AppHandle"), "Tauri close command must remain the app-facing adapter");
assert(commands.includes("close_pdf_document(file_id).await?"), "close command must delegate handle lifecycle to the core function");
assert(commands.includes("is_managed_temp_path"), "close command must retain guarded managed-temp cleanup");
assert(tests.includes("close_pdf_document(file_id).await"), "integration tests must exercise the app-independent lifecycle function");
assert(!tests.includes("close_pdf(file_id).await"), "integration tests must not bypass the AppHandle boundary");

console.log("native-lifecycle-contract: ok");
