import type { ColumnProfile, ProfilingState } from "./profiling.types";

export function createProfilingState(): ProfilingState {
  return {
    status: "closed",
    activeTab: "profile",
    documentId: null,
    column: null,
    profile: null,
    error: null,
  };
}

export function profileCacheKey(documentId: string, column: string) {
  return `${documentId}\u0000${column}`;
}

export class ProfilingSessionCache {
  private profiles = new Map<string, ColumnProfile>();

  get(documentId: string, column: string) {
    return this.profiles.get(profileCacheKey(documentId, column)) ?? null;
  }

  set(documentId: string, column: string, profile: ColumnProfile) {
    this.profiles.set(profileCacheKey(documentId, column), profile);
  }

  invalidate(documentId: string, column: string) {
    this.profiles.delete(profileCacheKey(documentId, column));
  }

  invalidateDocument(documentId: string) {
    const prefix = `${documentId}\u0000`;
    for (const key of this.profiles.keys()) {
      if (key.startsWith(prefix)) {
        this.profiles.delete(key);
      }
    }
  }

  renameColumn(documentId: string, oldColumn: string, newColumn: string) {
    const profile = this.get(documentId, oldColumn);
    this.invalidate(documentId, oldColumn);

    if (profile) {
      this.set(documentId, newColumn, {
        ...profile,
        column: newColumn,
      });
    }
  }
}
