import { invoke } from "@tauri-apps/api/core";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function canUseNativeFiles(): boolean {
  return typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
}

export async function readNativeTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeNativeTextFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}

export async function writeNativeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_binary_file", { path, dataBase64: bytesToBase64(bytes) });
}

export async function writeNativeTempFile(fileName: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>("write_temp_file", { fileName, dataBase64: bytesToBase64(bytes) });
}

export async function removeManagedImportTemp(path: string): Promise<void> {
  await invoke("remove_managed_import_temp", { path });
}

export function isManagedImportTempPath(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop() || "";
  return /^r0nix-import-[^\\/]+\.(?:pdf|md|markdown)$/i.test(fileName);
}

export async function collectNativeImportablePaths(root: string): Promise<string[]> {
  return invoke<string[]>("collect_importable_paths", { root });
}
