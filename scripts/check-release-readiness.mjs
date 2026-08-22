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
const tauriMain = readFileSync(path.join(root, "src-tauri/src/main.rs"), "utf8");
const releaseWorkflowPath = path.join(root, ".github/workflows/release.yml");
const releaseWorkflow = existsSync(releaseWorkflowPath) ? readFileSync(releaseWorkflowPath, "utf8") : "";
const ciWorkflowPath = path.join(root, ".github/workflows/ci.yml");
const ciWorkflow = existsSync(ciWorkflowPath) ? readFileSync(ciWorkflowPath, "utf8") : "";
const macosBundlePatchPath = path.join(root, "scripts/patch-macos-bundle.sh");
const macosNotarizePath = path.join(root, "scripts/notarize-macos-artifact.sh");
const windowsSmokePath = path.join(root, "scripts/windows-installer-smoke.ps1");
const macosSmokePath = path.join(root, "scripts/macos-bundle-smoke.sh");
const virtualizationCheckPath = path.join(root, "scripts/check-pdf-virtualization.mjs");
const pdfApiPath = path.join(root, "src/services/pdfApi.ts");
const pyRenderPath = path.join(root, "src-tauri/src/py_render.rs");

assert(typeof csp === "string" && csp.trim().length > 0, "Tauri CSP must be explicit and non-empty.");
assert(tauriConfig.build?.beforeBuildCommand === "npm run build", "Tauri release builds must compile the frontend from the current source.");
assert(bundle.targets === "all", "Tauri bundle targets must remain explicit.");
assert(Array.isArray(bundle.resources) && bundle.resources.includes("runtime"), "Embedded Python runtime must be included in desktop bundles.");
assert(tauriMain.includes("TrayIconBuilder") && tauriMain.includes('"tray-quit"'), "Desktop builds must keep a functional tray menu with an explicit quit action.");
assert(tauriMain.includes("cancel_llm_chat_completion"), "Desktop builds must expose native LLM request cancellation.");
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
assert(existsSync(macosBundlePatchPath), "macOS bundles must have a post-build runtime patch step.");
assert(releaseWorkflow.includes("patch-macos-bundle.sh"), "macOS release workflow must patch embedded dynamic-library paths after bundling.");
assert(existsSync(macosNotarizePath), "Signed macOS bundles must have an explicit post-patch notarization step.");
assert(releaseWorkflow.includes("notarize-macos-artifact.sh"), "Signed macOS release workflow must notarize patched artifacts.");
assert(existsSync(windowsSmokePath), "Windows releases must have an installer smoke test.");
assert(releaseWorkflow.includes("windows-installer-smoke.ps1"), "Windows release workflow must run the installed application smoke test.");
assert(existsSync(macosSmokePath), "macOS releases must have a bundle smoke test.");
assert(releaseWorkflow.includes("macos-bundle-smoke.sh"), "macOS release workflow must run the bundle smoke test.");
assert(ciWorkflow.includes("cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored"), "CI must exercise embedded PDF runtime regression tests.");
assert(ciWorkflow.includes("check:runtime-hygiene"), "CI must validate embedded Python runtime hygiene.");
assert(releaseWorkflow.includes("check:runtime-hygiene"), "Release workflow must validate embedded Python runtime hygiene.");
assert(existsSync(virtualizationCheckPath), "PDF virtualization must have a source-level budget check.");
const pdfApi = readFileSync(pdfApiPath, "utf8");
assert(!pdfApi.includes("not implemented"), "PDF API must not expose unimplemented placeholder operations.");
const pyRender = readFileSync(pyRenderPath, "utf8");
assert(pyRender.includes('PYTHONDONTWRITEBYTECODE'), "Embedded Python must not write runtime bytecode into Tauri's watched tree.");

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
