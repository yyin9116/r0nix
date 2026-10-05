import assert from "node:assert/strict";
import { documentIdForPath, documentPathKey, migrateDocumentArtifacts } from "../src/services/documentArtifacts.ts";

const documents = [{ id: "doc-stable-1", path: "/tmp/Paper.pdf" }];
assert.equal(documentPathKey(" /TMP/paper.pdf "), "/tmp/paper.pdf");
assert.equal(documentIdForPath(documents, "/tmp/paper.pdf"), "doc-stable-1");
const migrated = migrateDocumentArtifacts({
  "doc-stable-1": [{ id: "current-note", documentId: "doc-stable-1", content: "current" }],
  "/tmp/paper.pdf": [{ id: "legacy-note", content: "old" }],
}, documents);
assert.equal(migrated.changed, true);
assert.deepEqual(Object.keys(migrated.artifacts), ["doc-stable-1"]);
assert.deepEqual(migrated.artifacts["doc-stable-1"].map((item) => item.id), ["current-note", "legacy-note"]);
assert.ok(migrated.artifacts["doc-stable-1"].every((item) => item.documentId === "doc-stable-1"));
console.log("document artifact migration tests passed");
