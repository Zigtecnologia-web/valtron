import type { TransformationState, TransformationType } from "./transformation.types";

export function createTransformationState(): TransformationState {
  return {
    selectedType: null,
    configuration: {},
    status: "idle",
    preview: null,
    applied: null,
    error: null,
  };
}

export function defaultTransformationConfig(type: TransformationType): Record<string, unknown> {
  if (type === "replace") {
    return { find: "", replacement: "", regex: false };
  }

  if (type === "pad_left") {
    return { length: 11, character: "0" };
  }

  if (type === "excel_serial_date") {
    return { output_format: "DD/MM/YYYY" };
  }

  return {};
}
