export type InferredColumnType = "text" | "integer" | "decimal" | "date" | "datetime" | "boolean";

export type ColumnProfile = {
  column: string;
  physical_type: string;
  inferred_type: InferredColumnType;
  total_count: number;
  filled_count: number;
  empty_count: number;
  empty_percentage: number;
  distinct_count: number;
  duplicate_count: number;
  text_stats: TextStats | null;
  numeric_stats: NumericStats | null;
  date_stats: DateStats | null;
  boolean_stats: BooleanStat[] | null;
  top_values: ValueFrequency[];
  distribution: DistributionBucket[];
  performance: ColumnProfilePerformance;
};

export type TextStats = {
  min_length: number | null;
  avg_length: number | null;
  max_length: number | null;
};

export type NumericStats = {
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  stddev: number | null;
};

export type DateStats = {
  min: string | null;
  max: string | null;
  predominant_format: string | null;
  example_original: string | null;
  example_interpreted: string | null;
};

export type BooleanStat = {
  label: string;
  count: number;
  percentage: number;
};

export type ValueFrequency = {
  value: string;
  count: number;
};

export type DistributionBucket = {
  bucket: number;
  min: number;
  max: number;
  count: number;
};

export type ColumnProfilePerformance = {
  duckdb_ms: number;
  processing_ms: number;
  total_ms: number;
  cache_hit: boolean;
};

export type ProfilingStatus = "closed" | "loading" | "ready" | "error";
export type ProfilingTab = "profile" | "quality" | "transform";

export type ProfilingState = {
  status: ProfilingStatus;
  activeTab: ProfilingTab;
  documentId: string | null;
  column: string | null;
  profile: ColumnProfile | null;
  error: string | null;
};
