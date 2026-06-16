import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${relativePath}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tauriConfig = readJson("src-tauri/tauri.conf.json");
const capability = readJson("src-tauri/capabilities/default.json");
const packageJson = readJson("package.json");
const permissions = capability.permissions || [];
const csp = tauriConfig.app?.security?.csp;
const bundle = tauriConfig.bundle || {};
const cargoToml = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const releaseWorkflowPath = path.join(root, ".github/workflows/release.yml");
const releaseWorkflow = existsSync(releaseWorkflowPath) ? readFileSync(releaseWorkflowPath, "utf8") : "";

assert(typeof csp === "string" && csp.trim().length > 0, "Tauri CSP must be explicit and non-empty.");
assert(!csp.includes("default-src *"), "Tauri CSP must not allow every origin by default.");
assert(csp.includes("object-src 'none'"), "Tauri CSP must block object embeds.");
assert(csp.includes("base-uri 'self'"), "Tauri CSP must constrain base-uri.");

assert(
  bundle.createUpdaterArtifacts === false,
  "Updater artifacts must remain disabled until signing and update manifests are configured."
);
assert(!cargoToml.includes("tauri-plugin-updater"), "Updater plugin dependency is disabled until release signing is ready.");
assert(!cargoToml.includes("tauri-plugin-fs"), "Frontend FS plugin must stay disabled; use narrow Rust commands instead.");
assert(!permissions.some((entry) => String(entry).startsWith("fs:")), "Default capability must not expose broad fs permissions.");
assert(!permissions.includes("updater:default"), "Default capability must not expose updater permissions.");
assert(permissions.includes("shell:allow-open"), "Shell open permission is required for explicit external HTTP(S) links.");
assert(releaseWorkflow.includes("APPLE_CERTIFICATE"), "macOS release workflow must require Apple signing secrets.");
assert(releaseWorkflow.includes("APPLE_TEAM_ID"), "macOS release workflow must require Apple notarization team ID.");
assert(releaseWorkflow.includes('APPLE_SIGNING_IDENTITY: "-"'), "macOS release workflow must provide an ad-hoc signing fallback for unsigned builds.");
assert(releaseWorkflow.includes("Build Ad-Hoc macOS Bundles"), "macOS release workflow must name the ad-hoc packaging path explicitly.");

for (const iconPath of bundle.icon || []) {
  assert(existsSync(path.join(root, "src-tauri", iconPath)), `Missing bundle icon: ${iconPath}`);
}

const nsis = bundle.windows?.nsis || {};
for (const assetPath of [nsis.headerImage, nsis.sidebarImage, nsis.installerIcon, nsis.installerHooks]) {
  if (!assetPath) continue;
  assert(existsSync(path.join(root, "src-tauri", assetPath)), `Missing Windows installer asset: ${assetPath}`);
}

assert(
  packageJson.version === tauriConfig.version,
  `Package version (${packageJson.version}) must match Tauri version (${tauriConfig.version}).`
);

console.log("release-readiness: ok");
