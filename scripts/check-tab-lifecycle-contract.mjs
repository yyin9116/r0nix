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

// ── 标签拖拽排序（2026-10-08 反馈：「无法拖动标签页 tab 进行排序」）──────────
//
// 这一节存在的理由是那四个失效点**每一个都不会报错**，只会安静地不工作：
//  ① Group 缺 axis="x"→ 按 y 投影，横向拖动没有位移反馈；
//  ② values 传副本 → onReorder 的新序对不上当前 tabs，顺序弹回去；
//  ③ onReorder 没接 → 完全不能拖（这是上一版的状态）；
//  ④ 标签上的 onPointerDown 被 preventDefault → 拖拽手势根本不启动。
// 四者都是「接线写错」，单测测不出来，只能靠结构断言钉住。
const tabsSource = readFileSync("src/components/Tabs.tsx", "utf8");
assert(
  tabsSource.includes('import { AnimatePresence, motion, Reorder } from "motion/react";'),
  "tab reordering must use motion's Reorder rather than a hand-rolled drag handler."
);
assert(
  /<Reorder\.Group[\s\S]{0,400}?axis="x"/.test(tabsSource),
  'Reorder.Group must declare axis="x"; the default projects on y, so horizontal drags produce no movement.'
);
assert(
  tabsSource.includes("values={tabs}"),
  "Reorder.Group must receive the live tabs reference, not a copy — onReorder writes back by identity."
);
assert(
  tabsSource.includes("onReorder={onTabsReorder}"),
  "Reorder.Group must be wired to onTabsReorder; without it the group cannot reorder at all."
);
// 标签条同时要能横向滚动：滚动靠容器，拖拽靠标签，两者不能互相抢手势。
assert(
  tabsSource.includes("overflow-x-auto") || tabsSource.includes("overflowX"),
  "the tab strip must stay horizontally scrollable alongside reordering."
);
// App 侧：onReorder 回传的是**完整新数组**，所以必须整体替换而不是局部合并。
// 局部合并会让 tabs 丢掉未出现在增量里的标签（每拖一次少一个）。
// 窗口给得比实际距离宽：中间的注释解释了「为什么不能用闭包值」，删了它不该让断言失效。
const reorderHandlerAt = app.indexOf("onTabsReorder={(nextTabs) => {");
assert(reorderHandlerAt > 0, "App must pass an onTabsReorder handler to Tabs.");
assert(
  app.slice(reorderHandlerAt, reorderHandlerAt + 600).includes("setTabs(nextTabs)"),
  "App must apply the full array returned by onReorder; a partial merge would drop tabs."
);

console.log("tab-lifecycle-contract: ok");
