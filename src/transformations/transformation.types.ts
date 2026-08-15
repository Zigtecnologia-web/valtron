export type TransformationType =
  | "trim"
  | "uppercase"
  | "lowercase"
  | "replace"
  | "pad_left"
  | "excel_serial_date";

export type Transformation = {
  type: TransformationType;
  column: string;
  configuration: Record<string, unknown>;
};

export type TransformationSample = {
  original: string | null;
  transformed: string | null;
  status: "changed" | "failed" | string;
};

export type TransformationPerformance = {
  duckdb_ms: number;
  history_ms: number;
  total_ms: number;
};

export type TransformationPreview = {
  affected_rows: number;
  unchanged_rows: number;
  failed_rows: number;
  total_rows: number;
  samples: TransformationSample[];
  performance: TransformationPerformance;
};

export type AppliedTransformation = {
  id: string;
  affected_rows: number;
  failed_rows: number;
  performance: TransformationPerformance;
};

export type TransformationState = {
  selectedType: TransformationType | null;
  configuration: Record<string, unknown>;
  status: "idle" | "previewing" | "ready" | "applying" | "applied" | "error";
  preview: TransformationPreview | null;
  applied: AppliedTransformation | null;
  error: string | null;
};

export type TransformationDefinition = {
  type: TransformationType;
  label: string;
  description: string;
};
