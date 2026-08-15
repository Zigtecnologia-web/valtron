import type { QualityState } from "./quality.types";

export function createQualityState(): QualityState {
  return {
    status: "idle",
    mode: "list",
    rules: [],
    summary: null,
    error: null,
    editingRule: null,
    appliedRuleId: null,
  };
}
