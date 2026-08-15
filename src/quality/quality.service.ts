import { invoke } from "@tauri-apps/api/core";
import type { QualityRule, QualityRuleInput, QualityValidationSummary } from "./quality.types";

export function listQualityRules(documentId: string, columnName: string) {
  return invoke<QualityRule[]>("list_quality_rules", {
    documentId,
    columnName,
  });
}

export function createQualityRule(documentId: string, input: QualityRuleInput) {
  return invoke<QualityRule>("create_quality_rule", {
    documentId,
    input,
  });
}

export function updateQualityRule(ruleId: string, input: QualityRuleInput) {
  return invoke<QualityRule>("update_quality_rule", {
    ruleId,
    input,
  });
}

export function deleteQualityRule(ruleId: string) {
  return invoke<void>("delete_quality_rule", {
    ruleId,
  });
}

export function validateQualityRules(documentId: string, columnName: string) {
  return invoke<QualityValidationSummary>("validate_quality_rules", {
    documentId,
    columnName,
  });
}
