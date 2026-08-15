import type { InferredColumnType } from "../profiling/profiling.types";

export type QualityRuleType =
  | "required"
  | "unique"
  | "length"
  | "numeric"
  | "numeric_range"
  | "allowed_values"
  | "regex"
  | "date"
  | "email"
  | "cpf";

export type QualityRule = {
  id: string;
  document_id: string;
  column_name: string;
  rule_type: QualityRuleType;
  name: string;
  configuration_json: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type QualityRuleInput = {
  column_name: string;
  rule_type: QualityRuleType;
  name: string;
  configuration_json: string;
  enabled: boolean;
};

export type QualityRuleResult = {
  rule_id: string;
  rule_name: string;
  rule_type: QualityRuleType;
  total_rows: number;
  evaluated_rows: number;
  violation_count: number;
  violation_percentage: number;
  status: "ok" | "error" | "disabled";
  error: string | null;
  performance: QualityPerformance;
};

export type QualityValidationSummary = {
  document_id: string;
  column_name: string;
  total_rows: number;
  problem_rows: number;
  valid_rows: number;
  score: number;
  results: QualityRuleResult[];
  performance: QualityPerformance;
};

export type QualityPerformance = {
  duckdb_ms: number;
  processing_ms: number;
  total_ms: number;
  cache_hit: boolean;
};

export type QualityStatus = "idle" | "loading" | "ready" | "error";
export type QualityMode = "list" | "form";

export type QualityState = {
  status: QualityStatus;
  mode: QualityMode;
  rules: QualityRule[];
  summary: QualityValidationSummary | null;
  error: string | null;
  editingRule: QualityRule | null;
  appliedRuleId: string | null;
};

export type QualityRuleDefinition = {
  type: QualityRuleType;
  label: string;
  defaultName: string;
};

export type RuleConfig = {
  mode?: "exact" | "min" | "max" | "between";
  value?: number;
  min?: number;
  max?: number;
  inclusive?: boolean;
  values?: string[];
  ignore_case?: boolean;
  pattern?: string;
  format?: "DD/MM/YYYY" | "YYYY/MM/DD" | "YYYY-MM-DD" | "DD-MM-YYYY";
  accept_excel_serial?: boolean;
};

export function qualityRuleDefinitions(inferredType?: InferredColumnType): QualityRuleDefinition[] {
  const all: QualityRuleDefinition[] = [
    { type: "required", label: "Valor obrigatorio", defaultName: "Obrigatorio" },
    { type: "unique", label: "Valor unico", defaultName: "Unico" },
    { type: "length", label: "Comprimento", defaultName: "Comprimento esperado" },
    { type: "numeric", label: "Valor numerico", defaultName: "Deve ser numerico" },
    { type: "numeric_range", label: "Intervalo numerico", defaultName: "Intervalo numerico" },
    { type: "allowed_values", label: "Valores permitidos", defaultName: "Valores permitidos" },
    { type: "regex", label: "Padrao/regex", defaultName: "Padrao esperado" },
    { type: "date", label: "Data valida", defaultName: "Data valida" },
    { type: "email", label: "E-mail valido", defaultName: "E-mail valido" },
    { type: "cpf", label: "CPF valido", defaultName: "CPF valido" },
  ];
  const recommended =
    inferredType === "integer" || inferredType === "decimal"
      ? ["required", "numeric", "numeric_range"]
      : inferredType === "date" || inferredType === "datetime"
        ? ["date", "required"]
        : ["required", "unique", "length", "allowed_values"];
  return [
    ...all.filter((rule) => recommended.includes(rule.type)),
    ...all.filter((rule) => !recommended.includes(rule.type)),
  ];
}
