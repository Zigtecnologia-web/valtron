import { invoke } from "@tauri-apps/api/core";
import type {
  AppliedTransformation,
  Transformation,
  TransformationPreview,
} from "./transformation.types";

export function previewTransformation(documentId: string, transformation: Transformation) {
  return invoke<TransformationPreview>("preview_transformation", {
    documentId,
    transformation,
  });
}

export function applyTransformation(documentId: string, transformation: Transformation) {
  return invoke<AppliedTransformation>("apply_transformation", {
    documentId,
    transformation,
  });
}
