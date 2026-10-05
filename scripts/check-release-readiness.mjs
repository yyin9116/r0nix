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
const tauriCommands = readFileSync(path.join(root, "src-tauri/src/tauri_commands.rs"), "utf8");
const releaseWorkflowPath = path.join(root, ".github/workflows/release.yml");
const releaseWorkflow = existsSync(releaseWorkflowPath) ? readFileSync(releaseWorkflowPath, "utf8") : "";
const ciWorkflowPath = path.join(root, ".github/workflows/ci.yml");
const ciWorkflow = existsSync(ciWorkflowPath) ? readFileSync(ciWorkflowPath, "utf8") : "";
const macosBundlePatchPath = path.join(root, "scripts/patch-macos-bundle.sh");
const macosNotarizePath = path.join(root, "scripts/notarize-macos-artifact.sh");
const windowsSmokePath = path.join(root, "scripts/windows-installer-smoke.ps1");
const macosSmokePath = path.join(root, "scripts/macos-bundle-smoke.sh");
const macosProcessSmokePath = path.join(root, "scripts/macos-app-process-smoke.sh");
const macosBuildPath = path.join(root, "scripts/build-macos-bundle.sh");
const macosDmgPath = path.join(root, "scripts/create-macos-dmg.sh");
const macosSigningPath = path.join(root, "scripts/macos-signing.sh");
const virtualizationCheckPath = path.join(root, "scripts/check-pdf-virtualization.mjs");
const pdfApiPath = path.join(root, "src/services/pdfApi.ts");
const pyRenderPath = path.join(root, "src-tauri/src/py_render.rs");
const userSettingsPath = path.join(root, "src/services/userSettings.ts");

assert(typeof csp === "string" && csp.trim().length > 0, "Tauri CSP must be explicit and non-empty.");
assert(tauriConfig.build?.beforeBuildCommand === "npm run build", "Tauri release builds must compile the frontend from the current source.");
assert(bundle.targets === "all", "Tauri bundle targets must remain explicit.");
assert(Array.isArray(bundle.resources) && bundle.resources.includes("runtime"), "Embedded Python runtime must be included in desktop bundles.");
assert(tauriMain.includes("TrayIconBuilder") && tauriMain.includes('"tray-quit"'), "Desktop builds must keep a functional tray menu with an explicit quit action.");
assert(tauriMain.includes("MACOS_TRAY_ICON_PNG") && tauriMain.includes("icon_as_template(true)"), "macOS tray builds must use a dedicated template icon rather than the full-color app icon.");
assert(existsSync(path.join(root, "src-tauri/icons/tray-icon.png")), "macOS tray icon asset must exist.");
assert(tauriMain.includes("cancel_llm_chat_completion"), "Desktop builds must expose native LLM request cancellation.");
assert(tauriCommands.includes("only PDF files can be opened by open_pdf"), "Native PDF open must reject non-PDF paths at the command boundary.");
assert(tauriCommands.includes("native webview only supports http:// and https:// URLs"), "Native webviews must reject non-HTTP(S) schemes.");
assert(tauriCommands.includes("MAX_LLM_RESPONSE_BYTES"), "Native LLM responses must have a bounded memory size.");
assert(tauriCommands.includes("MAX_IMPORT_SCAN_DIRS") && tauriCommands.includes("IMPORT_SCAN_TIMEOUT"), "Folder imports must have bounded traversal work.");
assert(tauriCommands.includes("file_type()") && tauriCommands.includes("file_type.is_symlink()"), "Folder imports must not follow directory symlinks.");
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
assert(releaseWorkflow.includes("not notarized"), "Ad-hoc macOS release output must disclose that it is not notarized.");
assert(!releaseWorkflow.includes("Refusing to publish an unsigned macOS release from a version tag."), "Version-tagged macOS releases must not be blocked when the ad-hoc fallback is selected.");
assert(existsSync(macosBundlePatchPath), "macOS bundles must have a post-build runtime patch step.");
assert(releaseWorkflow.includes("patch-macos-bundle.sh"), "macOS release workflow must patch embedded dynamic-library paths after bundling.");
assert(releaseWorkflow.includes("create-macos-dmg.sh"), "macOS release workflow must create DMG from the patched app.");
assert(existsSync(macosNotarizePath), "Signed macOS bundles must have an explicit post-patch notarization step.");
assert(releaseWorkflow.includes("notarize-macos-artifact.sh"), "Signed macOS release workflow must notarize patched artifacts.");
assert(existsSync(windowsSmokePath), "Windows releases must have an installer smoke test.");
assert(releaseWorkflow.includes("windows-installer-smoke.ps1"), "Windows release workflow must run the installed application smoke test.");
assert(existsSync(macosSmokePath), "macOS releases must have a bundle smoke test.");
assert(existsSync(macosProcessSmokePath), "macOS releases must have an application process smoke test.");
assert(readFileSync(macosProcessSmokePath, "utf8").includes("Contents/MacOS/r0nix"), "macOS process smoke must launch the bundled binary.");
assert(releaseWorkflow.includes("macos-app-process-smoke.sh"), "macOS release workflow must verify application startup.");
assert(readFileSync(macosSmokePath, "utf8").includes("hdiutil attach"), "macOS bundle smoke must verify the app after mounting the DMG.");
assert(readFileSync(macosSmokePath, "utf8").includes('verify_app "$mount_point/r0nix.app"'), "macOS bundle smoke must inspect the app embedded in the DMG.");
assert(readFileSync(macosSmokePath, "utf8").includes("@rpath/libpython3.12.dylib"), "macOS bundle smoke must require the embedded Python runtime link.");
assert(readFileSync(macosSmokePath, "utf8").includes("/Library/Frameworks/Python.framework"), "macOS bundle smoke must reject developer-machine Python framework links.");
assert(existsSync(macosBuildPath), "macOS local bundles must have a build-and-patch entrypoint.");
assert(readFileSync(macosBuildPath, "utf8").includes("at least 4 GiB free disk space"), "macOS builds must fail early when the build volume is too full.");
assert(existsSync(macosDmgPath), "macOS bundles must be created from the patched app explicitly.");
assert(existsSync(macosSigningPath), "Signed macOS builds must import certificates into a temporary keychain.");
const macosSigning = readFileSync(macosSigningPath, "utf8");
assert(macosSigning.includes("security create-keychain"), "macOS signing must use an isolated keychain.");
assert(macosSigning.includes("security import") && macosSigning.includes("APPLE_CERTIFICATE_PASSWORD"), "macOS signing must import the configured certificate password.");
assert(macosSigning.includes("security set-key-partition-list"), "macOS signing must grant codesign keychain access non-interactively.");
assert(macosSigning.includes("security delete-keychain"), "Temporary macOS signing keychains must be removed after the build.");
assert(releaseWorkflow.includes("source scripts/macos-signing.sh"), "Signed macOS workflow must activate the temporary keychain setup.");
assert(releaseWorkflow.indexOf("trap cleanup_macos_signing EXIT") < releaseWorkflow.indexOf("setup_macos_signing"), "macOS signing cleanup must be installed before certificate setup can fail.");
assert(readFileSync(macosDmgPath, "utf8").includes("ln -s /Applications"), "macOS DMGs must include an Applications drop target.");
assert(packageJson.scripts?.["tauri:build:macos"], "Package scripts must expose the verified macOS bundle entrypoint.");
assert(packageJson.scripts?.["tauri:build:macos:debug"], "Package scripts must expose a verified debug macOS bundle entrypoint.");
assert(releaseWorkflow.includes("macos-bundle-smoke.sh"), "macOS release workflow must run the bundle smoke test.");
assert(ciWorkflow.includes("cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored"), "CI must exercise embedded PDF runtime regression tests.");
assert(ciWorkflow.includes("npm run test:e2e"), "CI must exercise browser P-level end-to-end regression tests.");
assert(ciWorkflow.includes("check:runtime-hygiene"), "CI must validate embedded Python runtime hygiene.");
assert(releaseWorkflow.includes("check:runtime-hygiene"), "Release workflow must validate embedded Python runtime hygiene.");
assert(releaseWorkflow.includes("npm run test:e2e"), "Release must exercise browser P-level end-to-end regression tests.");
assert(existsSync(virtualizationCheckPath), "PDF virtualization must have a source-level budget check.");
const pdfApi = readFileSync(pdfApiPath, "utf8");
assert(!pdfApi.includes("not implemented"), "PDF API must not expose unimplemented placeholder operations.");
const pyRender = readFileSync(pyRenderPath, "utf8");
assert(pyRender.includes('PYTHONDONTWRITEBYTECODE'), "Embedded Python must not write runtime bytecode into Tauri's watched tree.");
const userSettings = readFileSync(userSettingsPath, "utf8");
assert(userSettings.includes('const persisted = { ...next, aiApiKey: "" }'), "API keys must not be persisted in the plain local settings envelope.");
assert(userSettings.includes("const hasPersistedApiKey"), "Legacy persisted API keys must be scrubbed on compatible startup.");
const localStore = readFileSync(path.join(root, "src/services/localStore.ts"), "utf8");
assert(localStore.includes("The previous value was preserved"), "Local persistence failures must preserve prior data and emit a user-visible warning.");
assert(localStore.includes("forwardIncompatibleKeys"), "Older builds must not overwrite newer local persistence schemas.");

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
