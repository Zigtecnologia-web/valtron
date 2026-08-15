import { invoke } from "@tauri-apps/api/core";
import type { ColumnProfile } from "./profiling.types";

export function getColumnProfile(documentId: string, column: string) {
  return invoke<ColumnProfile>("get_column_profile", {
    documentId,
    column,
  });
}
