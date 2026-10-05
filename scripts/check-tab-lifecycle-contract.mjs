import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(app.includes("releasePdfFileAfterTabCommit"), "PDF handles must be released through the post-commit lifecycle helper.");
assert(app.includes("pendingPdfReleasesRef"), "PDF releases must be queued until the tab state commits.");
assert(app.includes("stillReferenced"), "A queued PDF release must verify that no remaining tab uses the file handle.");
assert(app.includes("flushPendingPdfReleases"), "Pending PDF releases must be flushed after tab state changes.");
assert(app.includes('"replace-document"'), "Replacing an already-open document must use deferred handle release.");
assert(app.includes('`close-tab:${closing.id}`'), "Closing a PDF tab must use deferred handle release.");
assert(app.includes('"delete-document"'), "Deleting a document must use deferred handle release.");
assert(app.includes("cancelledOpeningPathsRef"), "Closing a tab while its document is loading must mark the pending open as cancelled.");
assert(app.includes("if (cancelledOpeningPathsRef.current.has(openKey))"), "A cancelled document open must not recreate the closed tab.");
assert(app.includes("await api.closeFile(fileInfo.id)"), "A PDF opened after tab cancellation must release its newly allocated native handle.");
assert(app.includes('releasePdfFileAfterTabCommit(tab.fileId, `remove-document:${tab.id}`)'), "Removing a document must release any loaded handle belonging to its tab.");
assert(app.includes('cancelledOpeningPathsRef.current.add(tab.filePath.trim().toLowerCase())'), "Removing a document must cancel an in-flight document open.");
assert(app.includes("failed to release Markdown handle after open failure"), "Markdown import failures must release their native handle and owned temp file.");
assert(app.includes("failed to release uploaded file after import failure"), "Uploaded-file post-processing failures must release the native handle and owned temp file.");
assert(app.includes("function isEphemeralWebPdfPath"), "Temporary web PDF paths must be identified before persistence.");
assert(app.includes("filter((tab) => !isEphemeralWebPdfPath(tab.filePath))"), "Temporary web PDF tabs must not survive a restart with stale paths.");
assert(app.includes("filter((document) => !isEphemeralWebPdfPath(document.path))"), "Temporary web PDF documents must not pollute the persisted library.");
assert(app.includes("if (isEphemeralWebPdfPath(item.filePath)) return null"), "Previously persisted temporary web PDF tabs must be discarded during migration.");
assert(app.includes("r0nix-import"), "Uploaded temporary PDF tabs must not be persisted as reusable library paths.");
assert(app.includes("const failedTab = latestTabsRef.current.find"), "A failed restored document tab must be identified without mutating state during an updater.");
assert(app.includes("setTabs((prev) => prev.filter((tab) => tab.id !== failedTab.id))"), "A failed restored document tab must be removed to prevent an infinite reopen loop.");
assert(app.includes("latestActiveTabIdRef.current === failedTab.id"), "A failed active document tab must fall back to the library.");

const pdfService = readFileSync("src/services/pdfJsService.ts", "utf8");
assert(pdfService.includes("documentLoadingCache"), "PDF.js loading must be deduplicated per file ID.");
assert(pdfService.includes("type LoadingEntry"), "PDF.js loading must track an explicit cancellable entry.");
assert(pdfService.includes("await loadingEntry.destroy()"), "Closing a PDF must destroy an in-flight PDF.js load before waiting for it.");
assert(pdfService.includes("PDF_JS_LOAD_TIMEOUT_MS"), "PDF.js loading must have a bounded timeout.");
assert(pdfService.includes("loadingTask.destroy()"), "Timed-out PDF.js loading must destroy its loading task.");
assert(pdfService.includes("doc.destroy()"), "Closing a PDF must destroy the PDF.js document.");
assert(readFileSync("src/services/nativeFiles.ts", "utf8").includes("isManagedImportTempPath"), "Uploaded native files must carry an owned temp-file marker.");

console.log("tab-lifecycle-contract: ok");
