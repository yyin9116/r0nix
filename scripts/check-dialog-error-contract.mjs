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

console.log("dialog-error-contract: ok");
