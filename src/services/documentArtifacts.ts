import type { ReaderDocument } from "../types";

export function documentPathKey(path: string) {
  return path.trim().toLowerCase();
}

export function documentIdForPath(documents: ReaderDocument[], path: string) {
  const document = documents.find((item) => documentPathKey(item.path) === documentPathKey(path));
  return document?.id;
}

/** Move legacy path-keyed artifacts to the document's stable id without dropping duplicates. */
export function migrateDocumentArtifacts<T extends { id: string; documentId?: string }>(
  artifacts: Record<string, T[]>,
  documents: ReaderDocument[],
) {
  const next: Record<string, T[]> = { ...artifacts };
  let changed = false;

  for (const document of documents) {
    const legacyKey = documentPathKey(document.path);
    const legacyValues = artifacts[legacyKey];
    if (!legacyValues || legacyKey === document.id) continue;
    const normalized = legacyValues.map((value) => ({ ...value, documentId: document.id }));
    const merged = [...(artifacts[document.id] || []), ...normalized];
    const unique = new Map<string, T>();
    for (const value of merged) {
      if (!unique.has(value.id)) unique.set(value.id, value);
    }
    next[document.id] = Array.from(unique.values());
    delete next[legacyKey];
    changed = true;
  }

  for (const document of documents) {
    const values = next[document.id];
    if (!values) continue;
    const normalized = values.map((value) => ({ ...value, documentId: document.id }));
    if (normalized.some((value, index) => value.documentId !== values[index]?.documentId)) {
      next[document.id] = normalized;
      changed = true;
    }
  }

  return { artifacts: next, changed };
}
