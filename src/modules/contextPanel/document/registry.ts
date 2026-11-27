import { epubDocumentAdapter } from "./adapters/epubAdapter";
import { htmlSnapshotDocumentAdapter } from "./adapters/htmlSnapshotAdapter";
import { pdfDocumentAdapter } from "./adapters/pdfAdapter";
import type { DocumentAdapter, DocumentKind } from "./types";

const adapters: readonly DocumentAdapter[] = [
  pdfDocumentAdapter,
  epubDocumentAdapter,
  htmlSnapshotDocumentAdapter,
];

export function getDocumentAdapters(): readonly DocumentAdapter[] {
  return adapters;
}

export function getDocumentAdapter(kind: DocumentKind): DocumentAdapter | null {
  return adapters.find((adapter) => adapter.kind === kind) || null;
}

export function getDocumentAdapterForItem(
  item: Zotero.Item | null | undefined,
): DocumentAdapter | null {
  return adapters.find((adapter) => adapter.supports(item)) || null;
}
