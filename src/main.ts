import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  getInstalledVersion,
  installUpdate,
  type UpdateInfo,
  type UpdateProgress,
} from "./services/updater/updater.service";
import { renderProfilingDrawer, profileHeaderHint } from "./profiling/profiling.drawer";
import { getColumnProfile } from "./profiling/profiling.service";
import { createProfilingState, ProfilingSessionCache } from "./profiling/profiling.state";
import type { ColumnProfile, ProfilingState } from "./profiling/profiling.types";
import {
  createQualityRule,
  deleteQualityRule,
  listQualityRules,
  updateQualityRule,
  validateQualityRules,
} from "./quality/quality.service";
import { createQualityState } from "./quality/quality.state";
import type { QualityRule, QualityRuleInput, QualityState } from "./quality/quality.types";
import { applyTransformation, previewTransformation } from "./transformations/transformation.service";
import { createTransformationState, defaultTransformationConfig } from "./transformations/transformation.state";
import type { TransformationState, TransformationType } from "./transformations/transformation.types";
import "./styles.css";

type ImportSummary = {
  document_id: string;
  file_name: string;
  sheet_name: string;
  columns: string[];
  row_count: number;
  imported_at: string;
  import_duration_ms: number | null;
  import_performance: ImportPerformance | null;
};

type ImportPerformance = {
  import_strategy?: string;
  duckdb_xlsx_method?: string;
  duckdb_xlsx_options?: string;
  file_open_ms: number;
  xlsx_open_ms: number;
  worksheets_read_ms: number;
  excel_workbook_inspection_ms?: number;
  excel_header_detection_ms?: number;
  excel_sheet_import_ms?: number;
  excel_total_import_ms?: number;
  csv_generation_ms?: number;
  batch_size?: number;
  batch_count?: number;
  batch_build_total_ms?: number;
  batch_build_avg_ms?: number;
  duckdb_arrow_ingestion_ms?: number;
  duckdb_arrow_ingestion_avg_ms?: number;
  pipeline_wait_parser_ms?: number;
  pipeline_wait_duckdb_ms?: number;
  peak_memory_mb?: number;
  cell_conversion_ms: number;
  validation_ms: number;
  data_preparation_ms: number;
  duckdb_ms: number;
  duckdb_table_cleanup_ms: number;
  duckdb_table_creation_ms: number;
  duckdb_xlsx_import_ms?: number;
  duckdb_copy_ms?: number;
  duckdb_appender_ms: number;
  duckdb_flush_ms: number;
  duckdb_commit_ms: number;
  duckdb_final_queries_ms: number;
  auxiliary_structures_ms: number;
  frontend_events_ms: number;
  total_ms: number;
};

type ExcelSheetInfo = {
  name: string;
  index: number;
  visibility: string;
};

type ExcelWorkbookInspection = {
  file_name: string;
  sheets: ExcelSheetInfo[];
  inspection_duration_ms: number;
};

type DocumentInfo = {
  id: string;
  workspace_id: string;
  file_name: string;
  sheet_name: string;
  table_name: string;
  row_count: number;
  column_count: number;
  imported_at: string;
  import_duration_ms: number | null;
  import_performance: ImportPerformance | null;
};

type SqlContextMode = "document" | "workspace";

type SqlSourceInfo = {
  id: string;
  name: string;
  table_name: string;
  columns: string[];
  column_types: Record<string, string>;
};

type WorkspaceInfo = {
  id: string;
  name: string;
  created_at: string;
  document_count: number;
};

type ExcelSheetSelection = {
  sheetNames: Array<string | null>;
  workbookInspectionMs: number | null;
  inspection: ExcelWorkbookInspection | null;
};

type WorkspaceDestinationMode = "current" | "existing" | "new";

type WorkspaceDestinationDraft = {
  mode: WorkspaceDestinationMode;
  workspaceId: string | null;
  workspaceName: string;
};

type WorkspaceDestinationResult = WorkspaceDestinationDraft | "back" | null;

type PendingWorkspaceImport = {
  path: string;
  fileName: string;
  sheetNames: string[];
};

type ColumnFilter = {
  column: string;
  operator?: "contains" | "equals" | "empty" | "quality_violation";
  value: string;
  rule_id?: string | null;
};

type ColumnQuality = {
  column: string;
  empty_count: number;
};

type TableStats = {
  column_count: number;
  columns_with_empty: number;
  empty_cells: number;
  quality: ColumnQuality[];
};

type TablePage = {
  columns: string[];
  column_types?: Record<string, string>;
  rows: CellValue[][];
  row_ids?: Array<number | null>;
  total_rows: number;
  offset: number;
  limit: number;
  has_more?: boolean;
  next_offset?: number | null;
  sort_column: string | null;
  sort_direction: "asc" | "desc" | null;
  filters: ColumnFilter[];
  stats: TableStats;
  performance?: GridPerformance;
};

type GridPerformance = {
  query_duckdb_ms: number;
  rust_processing_ms: number;
  total_ms: number;
  rows: number;
  offset: number;
  limit: number;
};

type FilterFocusState = {
  column: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type CellPosition = {
  row: number;
  column: number;
};

type CellValue = string | null;

type ExportFormat = "csv" | "tsv" | "xlsx";

type VisibleColumnEntry = {
  column: string;
  index: number;
};

type ColumnPreferences = {
  width?: number;
  hidden?: boolean;
  order?: number;
  pinned?: "left" | "right" | null;
  wrap?: boolean;
};

type SelectedCellState = CellPosition & {
  rowId: string;
  columnName: string;
  value: CellValue;
};

type ActiveCellEdit = SelectedCellState & {
  originalValue: CellValue;
  value: CellValue;
  draft: string;
  operationId: number;
  status: "editing" | "saving";
  error: string | null;
};

type ResizeState = {
  pointerId: number;
  visibleIndex: number;
  columnName: string;
  startX: number;
  startWidth: number;
};

type SqlSuggestionKind = "keyword" | "function" | "table" | "column";

type SqlSuggestion = {
  label: string;
  insertText: string;
  detail: string;
  kind: SqlSuggestionKind;
};

type SqlHistoryEntry = {
  id: string;
  query: string;
  contextMode?: SqlContextMode;
  documentId?: string | null;
  workspaceId?: string | null;
  executedAt: number;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
};

type SavedSqlQuery = {
  id: string;
  name: string;
  query: string;
  contextMode?: SqlContextMode;
  documentId?: string | null;
  workspaceId?: string | null;
  savedAt: number;
};

type SqlFriendlyError = {
  title: string;
  message: string;
  suggestion?: string;
  technical: string;
};

const PAGE_SIZE = 100;
const GRID_BATCH_SIZE = PAGE_SIZE;
const GRID_ROW_HEIGHT = 42;
const GRID_OVERSCAN_ROWS = 8;
const GRID_PREFETCH_RATIO = 0.75;
const GRID_MAX_CACHED_BATCHES = 5;
const GRID_ROW_NUMBER_WIDTH = 72;
const FILTER_DEBOUNCE_MS = 275;
const COLUMN_VISIBILITY_STORAGE_PREFIX = "valtron.columnVisibility.v1";
const COLUMN_WIDTH_STORAGE_PREFIX = "valtron.columnWidths.v1";
const SQL_HISTORY_STORAGE_KEY = "valtron.sqlHistory.v1";
const SQL_SAVED_STORAGE_KEY = "valtron.savedSql.v1";
const SQL_HISTORY_LIMIT = 20;
const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "WITH",
  "DISTINCT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IS NULL",
  "IS NOT NULL",
  "LIKE",
  "IN",
];
const SQL_FUNCTIONS = [
  "COUNT()",
  "SUM()",
  "AVG()",
  "MIN()",
  "MAX()",
  "ROUND()",
  "COALESCE()",
  "NULLIF()",
  "TRY_CAST()",
  "CAST()",
  "LOWER()",
  "UPPER()",
  "TRIM()",
  "REPLACE()",
  "REGEXP_MATCHES()",
  "STRPTIME()",
];
const COLUMN_WIDTH_CONFIG = {
  min: 80,
  default: 180,
  maxInitial: 400,
  maxAutoFit: 500,
  resizeMax: 900,
  headerPadding: 58,
  cellPadding: 28,
  autoFitSampleSize: 500,
};

let currentOffset = 0;
let currentPage: TablePage | null = null;
let currentSummary: ImportSummary | null = null;
let workspaces: WorkspaceInfo[] = [];
let currentWorkspaceId: string | null = null;
let documents: DocumentInfo[] = [];
let currentDocumentId: string | null = null;
let sortColumn: string | null = null;
let sortDirection: "asc" | "desc" | null = null;
let filterValues = new Map<string, ColumnFilter>();
let filterTimer: number | undefined;
let gridDetailsVisible = false;
let sqlVisible = false;
let dataMode: "document" | "sql" = "document";
let currentSqlQuery: string | null = null;
let loadingCount = 0;
let pendingCellFocus: CellPosition | null = null;
let sidebarCollapsed = true;
let openDocumentMenuId: string | null = null;
let openColumnMenu: { column: string; index: number } | null = null;
let documentMenuPosition = { top: 0, left: 0 };
let columnMenuPosition = { top: 0, left: 0 };
let editingWorkspaceId: string | null = null;
let detailsDocumentId: string | null = null;
let renameDocumentId: string | null = null;
let renameColumnName: string | null = null;
let renameColumnIndex: number | null = null;
let exportDocumentId: string | null = null;
let exportInProgress = false;
let deleteDocumentId: string | null = null;
let resolveDeleteConfirmation: ((confirmed: boolean) => void) | null = null;
let pendingWorkspaceDestination: ((destination: WorkspaceDestinationResult) => void) | null = null;
let pendingImportSummary: ((confirmed: boolean) => void) | null = null;
let workspaceDestinationImport: PendingWorkspaceImport | null = null;
let selectedWorkspaceDestinationMode: WorkspaceDestinationMode = "current";
let workspaceDestinationSearch = "";
let installedVersion = "";
let pendingUpdateInfo: UpdateInfo | null = null;
let updateInProgress = false;
let columnSettingsOpen = false;
let gridRequestSeq = 0;
let gridSignature = "";
let gridRowsCache = new Map<number, CellValue[][]>();
let gridRowIdsCache = new Map<number, Array<number | null>>();
let gridLoadingOffsets = new Set<number>();
let gridKnownTotalRows = 0;
let gridRenderFrame = 0;
let gridLoading = false;
let columnPreferences = new Map<string, ColumnPreferences>();
let selectedCell: SelectedCellState | null = null;
let activeCellEdit: ActiveCellEdit | null = null;
let cellEditSeq = 0;
const recentCellUpdates = new Map<string, number>();
let cellPopoverEl: HTMLDivElement | null = null;
let activePopoverMode: "selection" | "hover" | null = null;
let resizeState: ResizeState | null = null;
let measureContext: CanvasRenderingContext2D | null = null;
let pendingCellOperations = new Map<string, number>();
let profilingState: ProfilingState = createProfilingState();
let qualityState: QualityState = createQualityState();
let transformationState: TransformationState = createTransformationState();
let profilingRequestSeq = 0;
const profilingCache = new ProfilingSessionCache();
let sqlPopoverMode: "columns" | "history" | "saved" | "menu" | null = null;
let sqlColumnSearch = "";
let sqlAutocompleteOpen = false;
let sqlAutocompleteItems: SqlSuggestion[] = [];
let sqlAutocompleteIndex = 0;
let sqlAutocompleteRange: { start: number; end: number } | null = null;
let sqlHistory: SqlHistoryEntry[] = [];
let savedSqlQueries: SavedSqlQuery[] = [];
let lastSqlExecutionMs: number | null = null;
let lastSqlFriendlyError: SqlFriendlyError | null = null;
let sqlSaveMode: "query" | "result" | null = null;
let sqlContextMode: SqlContextMode = "document";
let sqlSources: SqlSourceInfo[] = [];
let sqlSourcesRequestSeq = 0;
sqlHistory = readSqlHistory();
savedSqlQueries = readSavedSqlQueries();

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Elemento #app nao encontrado.");
}

app.innerHTML = `
  <main id="app-shell" class="app-shell sidebar-collapsed">
    <div id="loading-overlay" class="loading-overlay hidden" role="status" aria-live="polite">
      <div class="loading-panel">
        <span class="loading-spinner" aria-hidden="true"></span>
        <strong>Carregando</strong>
        <span id="loading-message">Processando arquivo...</span>
      </div>
    </div>

    <aside id="sidebar" class="sidebar-shell" aria-label="Menu lateral">
      <div class="sidebar-top">
        <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-label="Expandir menu lateral" title="Menu">
          ☰
        </button>
        <div>
          <p class="eyebrow sidebar-label">Workspace</p>
          <p class="sidebar-title sidebar-label">Valtron</p>
        </div>
      </div>

      <section class="workspace-shell">
        <p id="workspace-subtitle" class="toolbar-subtitle sidebar-label">Carregando workspaces...</p>
        <div class="workspace-actions">
          <div class="workspace-select-row">
            <select id="workspace-select" class="workspace-select" aria-label="Workspace ativo"></select>
            <button id="load-workspace" class="icon-button" type="button" aria-label="Editar workspace selecionado" title="Editar workspace selecionado">&#9998;</button>
          </div>
          <div class="workspace-create-row">
            <input id="workspace-name" class="workspace-name" placeholder="Novo workspace" />
            <button id="create-workspace" class="icon-button" type="button" aria-label="Salvar workspace" title="Salvar workspace">&#128190;</button>
          </div>
        </div>
      </section>

      <section class="documents-shell">
        <div class="documents-header">
          <div>
            <p class="toolbar-title sidebar-label">Documentos</p>
            <p id="documents-subtitle" class="toolbar-subtitle sidebar-label">Nenhum documento importado.</p>
          </div>
        </div>
        <div id="documents-list" class="documents-list"></div>
      </section>
    </aside>

    <div id="document-action-menu" class="document-menu" role="menu"></div>
    <div id="column-action-menu" class="column-menu" role="menu"></div>

    <div id="details-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="details-title">
      <section class="modal-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Detalhes</p>
            <h2 id="details-title">Importacao</h2>
          </div>
          <button id="close-details" class="icon-button modal-close" type="button" aria-label="Fechar detalhes">×</button>
        </div>
        <div id="details-content" class="details-list"></div>
      </section>
    </div>

    <div id="rename-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="rename-title">
      <section class="modal-panel rename-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Renomear</p>
            <h2 id="rename-title">Renomear documento</h2>
          </div>
          <button id="cancel-rename-x" class="icon-button modal-close" type="button" aria-label="Cancelar renomeacao">×</button>
        </div>
        <form id="rename-form" class="rename-form">
          <label for="rename-document-name">Nome do documento</label>
          <div class="rename-field-row">
            <input id="rename-document-name" class="rename-input" autocomplete="off" />
            <button id="save-rename" class="icon-button rename-save" type="submit" aria-label="Salvar nome do documento" title="Salvar nome do documento">
              <svg class="button-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path>
                <path d="M17 21v-8H7v8"></path>
                <path d="M7 3v5h8"></path>
              </svg>
            </button>
          </div>
        </form>
      </section>
    </div>

    <div id="rename-column-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="rename-column-title">
      <section class="modal-panel rename-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Renomear</p>
            <h2 id="rename-column-title">Renomear coluna</h2>
          </div>
          <button id="cancel-rename-column-x" class="icon-button modal-close" type="button" aria-label="Cancelar renomeacao da coluna">×</button>
        </div>
        <form id="rename-column-form" class="rename-form">
          <label for="rename-column-name">Nome da coluna</label>
          <div class="rename-field-row">
            <input id="rename-column-name" class="rename-input" autocomplete="off" />
            <button id="save-rename-column" class="icon-button rename-save" type="submit" aria-label="Salvar nome da coluna" title="Salvar nome da coluna">
              <svg class="button-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path>
                <path d="M17 21v-8H7v8"></path>
                <path d="M7 3v5h8"></path>
              </svg>
            </button>
          </div>
        </form>
      </section>
    </div>

    <div id="export-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <section class="modal-panel export-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Exportar</p>
            <h2 id="export-title">Exportar documento</h2>
          </div>
          <button id="cancel-export-x" class="icon-button modal-close" type="button" aria-label="Cancelar exportacao">×</button>
        </div>
        <form id="export-form" class="export-form">
          <label for="export-format">Formato de exportacao</label>
          <select id="export-format" class="export-select">
            <option value="csv">CSV (.csv)</option>
            <option value="tsv">TSV (.tsv)</option>
            <option value="xlsx">Excel (.xlsx)</option>
          </select>
          <div id="export-progress" class="export-progress hidden" role="status" aria-live="polite">
            <span class="loading-spinner export-spinner" aria-hidden="true"></span>
            <span>Salvando arquivo...</span>
          </div>
          <div class="modal-actions">
            <button id="run-export" class="primary-button export-submit" type="submit">
              <span id="export-button-spinner" class="loading-spinner export-button-spinner hidden" aria-hidden="true"></span>
              <span id="export-button-label">Exportar</span>
            </button>
          </div>
        </form>
      </section>
    </div>

    <div id="sheet-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <section class="modal-panel sheet-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Importar Excel</p>
            <h2 id="sheet-title">Escolher planilha</h2>
          </div>
          <button id="cancel-sheet-x" class="icon-button modal-close" type="button" aria-label="Cancelar importacao">×</button>
        </div>
        <form id="sheet-form" class="sheet-form">
          <div>
            <p id="sheet-file-name" class="sheet-file-name"></p>
            <p id="sheet-subtitle" class="toolbar-subtitle"></p>
          </div>
          <div class="sheet-tools">
            <button id="select-all-sheets" class="ghost-button compact" type="button">Selecionar todas</button>
          </div>
          <div id="sheet-list" class="sheet-list"></div>
          <div class="modal-actions">
            <button id="cancel-sheet" class="ghost-button" type="button">Cancelar</button>
            <button id="confirm-sheet" class="primary-button" type="submit">Importar</button>
          </div>
        </form>
      </section>
    </div>

    <div id="workspace-destination-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="workspace-destination-title">
      <section class="modal-panel workspace-destination-panel">
        <div class="modal-header">
          <div>
            <p id="workspace-destination-eyebrow" class="eyebrow">Organizar documentos</p>
            <h2 id="workspace-destination-title">Destino da importacao</h2>
          </div>
          <button id="cancel-workspace-destination-x" class="icon-button modal-close" type="button" aria-label="Cancelar importacao">×</button>
        </div>
        <form id="workspace-destination-form" class="workspace-destination-form">
          <div id="workspace-destination-content" class="workspace-destination-content"></div>
          <div id="workspace-destination-error" class="workspace-destination-error" role="alert"></div>
          <div class="modal-actions">
            <button id="back-workspace-destination" class="ghost-button" type="button">Voltar</button>
            <button id="confirm-workspace-destination" class="primary-button" type="submit">Continuar</button>
          </div>
        </form>
      </section>
    </div>

    <div id="delete-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <section class="modal-panel confirm-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow danger-eyebrow">Excluir</p>
            <h2 id="delete-title">Excluir documento?</h2>
          </div>
          <button id="cancel-delete-x" class="icon-button modal-close" type="button" aria-label="Cancelar exclusao">×</button>
        </div>
        <p id="delete-message" class="confirm-message"></p>
        <div class="modal-actions">
          <button id="cancel-delete" class="ghost-button" type="button">Cancelar</button>
          <button id="confirm-delete" class="danger-button" type="button">Excluir</button>
        </div>
      </section>
    </div>

    <div id="columns-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="columns-title">
      <section class="modal-panel columns-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Grid</p>
            <h2 id="columns-title">Colunas</h2>
          </div>
          <button id="close-columns-x" class="icon-button modal-close" type="button" aria-label="Fechar colunas">×</button>
        </div>
        <div class="columns-content">
          <p id="columns-subtitle" class="toolbar-subtitle">Selecione as colunas visiveis neste documento.</p>
          <div id="columns-list" class="columns-list"></div>
        </div>
        <div class="modal-actions">
          <button id="show-all-columns" class="ghost-button" type="button">Mostrar todas</button>
          <button id="close-columns" class="primary-button" type="button">Fechar</button>
        </div>
      </section>
    </div>

    <div id="update-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <section class="modal-panel update-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Atualizacao</p>
            <h2 id="update-title">Nova versao disponivel</h2>
          </div>
          <button id="close-update-x" class="icon-button modal-close" type="button" aria-label="Atualizar depois">×</button>
        </div>
        <div class="update-content">
          <p id="update-version" class="update-version">Valtron</p>
          <p id="update-message" class="confirm-message">Uma nova versao do Valtron esta disponivel.</p>
          <div id="update-notes-shell" class="update-notes hidden">
            <p class="toolbar-title">Novidades</p>
            <div id="update-notes"></div>
          </div>
          <div id="update-progress" class="update-progress hidden" role="status" aria-live="polite">
            <div class="update-progress-header">
              <span id="update-progress-label">Baixando atualizacao</span>
              <strong id="update-progress-percent">0%</strong>
            </div>
            <div class="update-progress-track">
              <span id="update-progress-bar"></span>
            </div>
            <p>Nao feche o Valtron durante a atualizacao.</p>
          </div>
          <p id="update-error" class="update-error hidden"></p>
        </div>
        <div class="modal-actions">
          <button id="skip-update" class="ghost-button" type="button">Depois</button>
          <button id="install-update" class="primary-button" type="button">Atualizar agora</button>
        </div>
      </section>
    </div>

    <div id="about-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <section class="modal-panel about-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Sobre</p>
            <h2 id="about-title">Valtron</h2>
          </div>
          <button id="close-about-x" class="icon-button modal-close" type="button" aria-label="Fechar sobre">×</button>
        </div>
        <div class="about-content">
          <p id="about-version" class="confirm-message">Versao carregando...</p>
          <p id="manual-update-status" class="toolbar-subtitle">Atualizacoes automaticas ficam ativas na versao instalada.</p>
        </div>
        <div class="modal-actions">
          <button id="manual-update-check" class="ghost-button" type="button">Verificar atualizacoes</button>
          <button id="close-about" class="primary-button" type="button">Fechar</button>
        </div>
      </section>
    </div>

    <section class="content-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Valtron Data Studio</p>
          <h1>Valtron</h1>
        </div>
        <div class="topbar-actions">
          <button id="toggle-grid-details" class="ghost-button" type="button">Detalhes</button>
          <button id="toggle-sql" class="ghost-button" type="button">Console SQL</button>
          <button id="open-about" class="ghost-button" type="button">Sobre</button>
          <button id="import-button" class="primary-button" type="button">
            <svg class="button-icon" aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 3v10m0 0 4-4m-4 4-4-4"></path>
              <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"></path>
            </svg>
            <span>Importar</span>
          </button>
        </div>
      </header>

      <section id="drop-zone" class="import-zone">
        <div>
          <p class="zone-title">Arquivo XLSX ou CSV</p>
          <p id="status" class="status">Nenhum arquivo importado.</p>
        </div>
        <div class="zone-meta">
          <span id="file-name">-</span>
          <span id="sheet-name">-</span>
        </div>
      </section>

    <section id="sql-shell" class="sql-shell hidden">
      <div class="sql-editor">
        <div>
          <p class="toolbar-title">Console SQL</p>
          <p id="sql-subtitle" class="toolbar-subtitle">Consultas de leitura, limite visual de 500 linhas.</p>
        </div>
        <div class="sql-toolbar" aria-label="Ferramentas SQL">
          <label class="sql-context-control">
            <span>Contexto</span>
            <select id="sql-context-mode">
              <option value="document">Documento atual</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <span id="sql-context-label" class="sql-context-label">Documento atual</span>
          <button id="sql-columns-button" class="ghost-button compact-button" type="button">Colunas</button>
          <button id="sql-history-button" class="ghost-button compact-button" type="button">Historico</button>
          <button id="sql-saved-button" class="ghost-button compact-button" type="button">Salvas</button>
          <button id="sql-menu-button" class="ghost-button compact-button icon-only-button" type="button" aria-label="Acoes SQL">...</button>
        </div>
        <div class="sql-code-wrap">
          <pre id="sql-highlight" aria-hidden="true"></pre>
          <textarea id="sql-query" spellcheck="false">SELECT *
FROM documento;</textarea>
          <div id="sql-autocomplete" class="sql-autocomplete hidden" role="listbox"></div>
        </div>
        <div class="sql-actions">
          <button id="run-sql" class="primary-button" type="button">Executar SQL</button>
          <button id="clear-sql" class="ghost-button" type="button">Voltar documento</button>
        </div>
      </div>
      <div id="sql-popover" class="sql-popover hidden"></div>
      <div id="sql-error" class="sql-error-panel hidden"></div>
      <div class="sql-result-row">
        <p id="sql-status" class="toolbar-subtitle">O resultado vai aparecer na grid principal.</p>
        <button id="save-sql-result" class="ghost-button compact-button hidden" type="button">Salvar como documento</button>
      </div>
    </section>

    <div id="sql-save-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="sql-save-title">
      <section class="modal-panel narrow-panel">
        <div class="modal-header">
          <div>
            <p id="sql-save-eyebrow" class="eyebrow">SQL</p>
            <h2 id="sql-save-title">Salvar consulta</h2>
          </div>
          <button id="cancel-sql-save-x" class="icon-button modal-close" type="button" aria-label="Fechar">×</button>
        </div>
        <form id="sql-save-form">
          <div class="form-field">
            <label id="sql-save-name-label" for="sql-save-name">Nome</label>
            <input id="sql-save-name" name="sql-save-name" autocomplete="off" />
          </div>
          <p id="sql-save-error" class="update-error hidden"></p>
          <div class="modal-actions">
            <button id="cancel-sql-save" class="ghost-button" type="button">Cancelar</button>
            <button id="confirm-sql-save" class="primary-button" type="submit">Salvar</button>
          </div>
        </form>
      </section>
    </div>

    <section id="grid-details-panel" class="grid-details-panel hidden" aria-label="Detalhes da grid">
      <div class="details-panel-header">
        <div>
          <p class="toolbar-title">Detalhes</p>
          <p class="toolbar-subtitle">Resumo de linhas, colunas, filtros e vazios.</p>
        </div>
        <button id="close-grid-details" class="ghost-button" type="button">Fechar</button>
      </div>

      <section class="stats-grid" aria-label="Resumo da importacao">
        <article>
          <span>Linhas</span>
          <strong id="row-count">0</strong>
        </article>
        <article>
          <span>Colunas</span>
          <strong id="column-count">0</strong>
        </article>
        <article>
          <span>Colunas com vazio</span>
          <strong id="empty-column-count">0</strong>
        </article>
        <article>
          <span>Celulas vazias</span>
          <strong id="empty-cell-count">0</strong>
        </article>
        <article>
          <span>Filtros</span>
          <strong id="filter-count">0</strong>
        </article>
        <article>
          <span>Pagina</span>
          <strong id="page-range">-</strong>
        </article>
      </section>

      <section class="quality-shell">
        <div>
          <p class="toolbar-title">Incidencia de vazio por coluna</p>
          <p id="quality-subtitle" class="toolbar-subtitle">Importe um arquivo para calcular.</p>
        </div>
        <div id="quality-list" class="quality-list"></div>
      </section>
    </section>

    <section class="table-shell">
      <div class="table-toolbar">
        <div>
          <p class="toolbar-title">Dados importados</p>
          <p id="table-subtitle" class="toolbar-subtitle">Aguardando importacao.</p>
        </div>
        <div class="pager">
          <span id="grid-loading-status" class="grid-loading-status" aria-live="polite"></span>
          <button id="clear-filters" class="ghost-button" type="button" disabled>Limpar filtros</button>
          <button id="open-columns" class="ghost-button" type="button" disabled>Colunas</button>
        </div>
      </div>

      <div id="table-viewport" class="table-viewport">
        <div id="table-head" class="grid-head"></div>
        <div id="table-body" class="grid-body">
          <div class="empty-cell">Importe um arquivo para visualizar os dados.</div>
        </div>
      </div>
    </section>
    <div id="profiling-root" class="profiling-root hidden"></div>
    </section>
  </main>
`;

const appShellEl = document.querySelector<HTMLElement>("#app-shell");
const sidebarToggleButton = document.querySelector<HTMLButtonElement>("#sidebar-toggle");
const importButton = document.querySelector<HTMLButtonElement>("#import-button");
const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const fileNameEl = document.querySelector<HTMLSpanElement>("#file-name");
const sheetNameEl = document.querySelector<HTMLSpanElement>("#sheet-name");
const workspaceSubtitleEl = document.querySelector<HTMLParagraphElement>("#workspace-subtitle");
const workspaceSelectEl = document.querySelector<HTMLSelectElement>("#workspace-select");
const loadWorkspaceButton = document.querySelector<HTMLButtonElement>("#load-workspace");
const workspaceNameEl = document.querySelector<HTMLInputElement>("#workspace-name");
const createWorkspaceButton = document.querySelector<HTMLButtonElement>("#create-workspace");
const documentsSubtitleEl = document.querySelector<HTMLParagraphElement>("#documents-subtitle");
const documentsListEl = document.querySelector<HTMLDivElement>("#documents-list");
const documentActionMenuEl = document.querySelector<HTMLDivElement>("#document-action-menu");
const columnActionMenuEl = document.querySelector<HTMLDivElement>("#column-action-menu");
const detailsModalEl = document.querySelector<HTMLDivElement>("#details-modal");
const detailsContentEl = document.querySelector<HTMLDivElement>("#details-content");
const closeDetailsButton = document.querySelector<HTMLButtonElement>("#close-details");
const renameModalEl = document.querySelector<HTMLDivElement>("#rename-modal");
const renameFormEl = document.querySelector<HTMLFormElement>("#rename-form");
const renameDocumentNameEl = document.querySelector<HTMLInputElement>("#rename-document-name");
const cancelRenameXButton = document.querySelector<HTMLButtonElement>("#cancel-rename-x");
const saveRenameButton = document.querySelector<HTMLButtonElement>("#save-rename");
const renameColumnModalEl = document.querySelector<HTMLDivElement>("#rename-column-modal");
const renameColumnFormEl = document.querySelector<HTMLFormElement>("#rename-column-form");
const renameColumnNameEl = document.querySelector<HTMLInputElement>("#rename-column-name");
const cancelRenameColumnXButton = document.querySelector<HTMLButtonElement>("#cancel-rename-column-x");
const saveRenameColumnButton = document.querySelector<HTMLButtonElement>("#save-rename-column");
const exportModalEl = document.querySelector<HTMLDivElement>("#export-modal");
const exportFormEl = document.querySelector<HTMLFormElement>("#export-form");
const exportFormatEl = document.querySelector<HTMLSelectElement>("#export-format");
const exportProgressEl = document.querySelector<HTMLDivElement>("#export-progress");
const cancelExportXButton = document.querySelector<HTMLButtonElement>("#cancel-export-x");
const runExportButton = document.querySelector<HTMLButtonElement>("#run-export");
const exportButtonSpinnerEl = document.querySelector<HTMLSpanElement>("#export-button-spinner");
const exportButtonLabelEl = document.querySelector<HTMLSpanElement>("#export-button-label");
const sheetModalEl = document.querySelector<HTMLDivElement>("#sheet-modal");
const sheetFormEl = document.querySelector<HTMLFormElement>("#sheet-form");
const sheetFileNameEl = document.querySelector<HTMLParagraphElement>("#sheet-file-name");
const sheetSubtitleEl = document.querySelector<HTMLParagraphElement>("#sheet-subtitle");
const sheetListEl = document.querySelector<HTMLDivElement>("#sheet-list");
const cancelSheetButton = document.querySelector<HTMLButtonElement>("#cancel-sheet");
const cancelSheetXButton = document.querySelector<HTMLButtonElement>("#cancel-sheet-x");
const confirmSheetButton = document.querySelector<HTMLButtonElement>("#confirm-sheet");
const selectAllSheetsButton = document.querySelector<HTMLButtonElement>("#select-all-sheets");
const workspaceDestinationModalEl = document.querySelector<HTMLDivElement>("#workspace-destination-modal");
const workspaceDestinationFormEl = document.querySelector<HTMLFormElement>("#workspace-destination-form");
const workspaceDestinationEyebrowEl = document.querySelector<HTMLParagraphElement>("#workspace-destination-eyebrow");
const workspaceDestinationTitleEl = document.querySelector<HTMLHeadingElement>("#workspace-destination-title");
const workspaceDestinationContentEl = document.querySelector<HTMLDivElement>("#workspace-destination-content");
const workspaceDestinationErrorEl = document.querySelector<HTMLDivElement>("#workspace-destination-error");
const cancelWorkspaceDestinationXButton = document.querySelector<HTMLButtonElement>("#cancel-workspace-destination-x");
const backWorkspaceDestinationButton = document.querySelector<HTMLButtonElement>("#back-workspace-destination");
const confirmWorkspaceDestinationButton = document.querySelector<HTMLButtonElement>("#confirm-workspace-destination");
const deleteModalEl = document.querySelector<HTMLDivElement>("#delete-modal");
const deleteMessageEl = document.querySelector<HTMLParagraphElement>("#delete-message");
const cancelDeleteButton = document.querySelector<HTMLButtonElement>("#cancel-delete");
const cancelDeleteXButton = document.querySelector<HTMLButtonElement>("#cancel-delete-x");
const confirmDeleteButton = document.querySelector<HTMLButtonElement>("#confirm-delete");
const columnsModalEl = document.querySelector<HTMLDivElement>("#columns-modal");
const columnsSubtitleEl = document.querySelector<HTMLParagraphElement>("#columns-subtitle");
const columnsListEl = document.querySelector<HTMLDivElement>("#columns-list");
const closeColumnsXButton = document.querySelector<HTMLButtonElement>("#close-columns-x");
const closeColumnsButton = document.querySelector<HTMLButtonElement>("#close-columns");
const showAllColumnsButton = document.querySelector<HTMLButtonElement>("#show-all-columns");
const updateModalEl = document.querySelector<HTMLDivElement>("#update-modal");
const closeUpdateXButton = document.querySelector<HTMLButtonElement>("#close-update-x");
const updateVersionEl = document.querySelector<HTMLParagraphElement>("#update-version");
const updateMessageEl = document.querySelector<HTMLParagraphElement>("#update-message");
const updateNotesShellEl = document.querySelector<HTMLDivElement>("#update-notes-shell");
const updateNotesEl = document.querySelector<HTMLDivElement>("#update-notes");
const updateProgressEl = document.querySelector<HTMLDivElement>("#update-progress");
const updateProgressLabelEl = document.querySelector<HTMLSpanElement>("#update-progress-label");
const updateProgressPercentEl = document.querySelector<HTMLElement>("#update-progress-percent");
const updateProgressBarEl = document.querySelector<HTMLSpanElement>("#update-progress-bar");
const updateErrorEl = document.querySelector<HTMLParagraphElement>("#update-error");
const skipUpdateButton = document.querySelector<HTMLButtonElement>("#skip-update");
const installUpdateButton = document.querySelector<HTMLButtonElement>("#install-update");
const openAboutButton = document.querySelector<HTMLButtonElement>("#open-about");
const aboutModalEl = document.querySelector<HTMLDivElement>("#about-modal");
const closeAboutXButton = document.querySelector<HTMLButtonElement>("#close-about-x");
const closeAboutButton = document.querySelector<HTMLButtonElement>("#close-about");
const aboutVersionEl = document.querySelector<HTMLParagraphElement>("#about-version");
const manualUpdateStatusEl = document.querySelector<HTMLParagraphElement>("#manual-update-status");
const manualUpdateCheckButton = document.querySelector<HTMLButtonElement>("#manual-update-check");
const toggleGridDetailsButton = document.querySelector<HTMLButtonElement>("#toggle-grid-details");
const closeGridDetailsButton = document.querySelector<HTMLButtonElement>("#close-grid-details");
const gridDetailsPanelEl = document.querySelector<HTMLElement>("#grid-details-panel");
const toggleSqlButton = document.querySelector<HTMLButtonElement>("#toggle-sql");
const sqlShellEl = document.querySelector<HTMLElement>("#sql-shell");
const sqlQueryEl = document.querySelector<HTMLTextAreaElement>("#sql-query");
const sqlHighlightEl = document.querySelector<HTMLPreElement>("#sql-highlight");
const sqlContextModeEl = document.querySelector<HTMLSelectElement>("#sql-context-mode");
const sqlContextLabelEl = document.querySelector<HTMLSpanElement>("#sql-context-label");
const sqlAutocompleteEl = document.querySelector<HTMLDivElement>("#sql-autocomplete");
const sqlColumnsButton = document.querySelector<HTMLButtonElement>("#sql-columns-button");
const sqlHistoryButton = document.querySelector<HTMLButtonElement>("#sql-history-button");
const sqlSavedButton = document.querySelector<HTMLButtonElement>("#sql-saved-button");
const sqlMenuButton = document.querySelector<HTMLButtonElement>("#sql-menu-button");
const sqlPopoverEl = document.querySelector<HTMLDivElement>("#sql-popover");
const sqlErrorEl = document.querySelector<HTMLDivElement>("#sql-error");
const sqlStatusEl = document.querySelector<HTMLParagraphElement>("#sql-status");
const runSqlButton = document.querySelector<HTMLButtonElement>("#run-sql");
const clearSqlButton = document.querySelector<HTMLButtonElement>("#clear-sql");
const saveSqlResultButton = document.querySelector<HTMLButtonElement>("#save-sql-result");
const sqlSaveModalEl = document.querySelector<HTMLDivElement>("#sql-save-modal");
const sqlSaveFormEl = document.querySelector<HTMLFormElement>("#sql-save-form");
const sqlSaveEyebrowEl = document.querySelector<HTMLParagraphElement>("#sql-save-eyebrow");
const sqlSaveTitleEl = document.querySelector<HTMLHeadingElement>("#sql-save-title");
const sqlSaveNameLabelEl = document.querySelector<HTMLLabelElement>("#sql-save-name-label");
const sqlSaveNameEl = document.querySelector<HTMLInputElement>("#sql-save-name");
const sqlSaveErrorEl = document.querySelector<HTMLParagraphElement>("#sql-save-error");
const cancelSqlSaveXButton = document.querySelector<HTMLButtonElement>("#cancel-sql-save-x");
const cancelSqlSaveButton = document.querySelector<HTMLButtonElement>("#cancel-sql-save");
const confirmSqlSaveButton = document.querySelector<HTMLButtonElement>("#confirm-sql-save");
const loadingOverlayEl = document.querySelector<HTMLDivElement>("#loading-overlay");
const loadingMessageEl = document.querySelector<HTMLSpanElement>("#loading-message");
const rowCountEl = document.querySelector<HTMLElement>("#row-count");
const columnCountEl = document.querySelector<HTMLElement>("#column-count");
const emptyColumnCountEl = document.querySelector<HTMLElement>("#empty-column-count");
const emptyCellCountEl = document.querySelector<HTMLElement>("#empty-cell-count");
const filterCountEl = document.querySelector<HTMLElement>("#filter-count");
const pageRangeEl = document.querySelector<HTMLElement>("#page-range");
const qualitySubtitleEl = document.querySelector<HTMLParagraphElement>("#quality-subtitle");
const qualityListEl = document.querySelector<HTMLDivElement>("#quality-list");
const tableSubtitleEl = document.querySelector<HTMLParagraphElement>("#table-subtitle");
const tableViewportEl = document.querySelector<HTMLDivElement>("#table-viewport");
const tableHeadEl = document.querySelector<HTMLElement>("#table-head");
const tableBodyEl = document.querySelector<HTMLElement>("#table-body");
const prevButton = document.querySelector<HTMLButtonElement>("#prev-page");
const nextButton = document.querySelector<HTMLButtonElement>("#next-page");
const clearFiltersButton = document.querySelector<HTMLButtonElement>("#clear-filters");
const openColumnsButton = document.querySelector<HTMLButtonElement>("#open-columns");
const gridLoadingStatusEl = document.querySelector<HTMLSpanElement>("#grid-loading-status");
const profilingRootEl = document.querySelector<HTMLDivElement>("#profiling-root");

function setStatus(message: string) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function formatImportErrorMessage(error: unknown) {
  const message = String(error);

  if (message.includes("Detalhes tecnicos:")) {
    return message;
  }

  if (message.includes("DuckDB nao conseguiu criar a tabela diretamente do XLSX")) {
    return `Nao foi possivel importar esta planilha.\n\nO arquivo possui uma estrutura XLSX que nao pode ser lida pelo mecanismo de importacao.\n\nDetalhes tecnicos: ${message}`;
  }

  return message;
}

function setManualUpdateStatus(message: string) {
  if (manualUpdateStatusEl) {
    manualUpdateStatusEl.textContent = message;
  }
}

function renderInstalledVersion() {
  const versionText = installedVersion ? `Versao ${installedVersion}` : "Versao carregando...";

  if (aboutVersionEl) {
    aboutVersionEl.textContent = versionText;
  }
}

function formatUpdateNotes(body: string | null) {
  const notes = (body ?? "").trim();

  if (!notes) {
    return "";
  }

  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => `<p>${escapeHtml(line.replace(/^[-*]\s*/, ""))}</p>`).join("");
}

function renderUpdateModal(update: UpdateInfo) {
  pendingUpdateInfo = update;

  if (updateVersionEl) {
    updateVersionEl.textContent = `Valtron ${update.version}`;
  }

  if (updateMessageEl) {
    updateMessageEl.textContent = `Voce esta usando a versao ${update.currentVersion}. Uma nova versao esta disponivel.`;
  }

  const notesHtml = formatUpdateNotes(update.body);
  updateNotesShellEl?.classList.toggle("hidden", !notesHtml);

  if (updateNotesEl) {
    updateNotesEl.innerHTML = notesHtml;
  }

  setUpdateProgress(null);
  setUpdateError("");
  setUpdateInProgress(false);
  updateModalEl?.classList.remove("hidden");
}

function closeUpdateModal() {
  if (updateInProgress) {
    return;
  }

  updateModalEl?.classList.add("hidden");
}

function openAboutModal() {
  renderInstalledVersion();
  setManualUpdateStatus("Atualizacoes automaticas ficam ativas na versao instalada.");
  aboutModalEl?.classList.remove("hidden");
}

function closeAboutModal() {
  aboutModalEl?.classList.add("hidden");
}

function setUpdateError(message: string) {
  if (!updateErrorEl) {
    return;
  }

  updateErrorEl.textContent = message;
  updateErrorEl.classList.toggle("hidden", !message);
}

function setUpdateInProgress(inProgress: boolean) {
  updateInProgress = inProgress;

  if (installUpdateButton) {
    installUpdateButton.disabled = inProgress;
    installUpdateButton.textContent = inProgress ? "Atualizando..." : "Atualizar agora";
  }

  if (skipUpdateButton) {
    skipUpdateButton.disabled = inProgress;
  }

  if (closeUpdateXButton) {
    closeUpdateXButton.disabled = inProgress;
  }
}

function setUpdateProgress(progress: UpdateProgress | null) {
  updateProgressEl?.classList.toggle("hidden", !progress);

  const percent = progress?.percent ?? 0;

  if (updateProgressPercentEl) {
    updateProgressPercentEl.textContent = progress?.percent === null ? "--" : `${percent}%`;
  }

  if (updateProgressBarEl) {
    updateProgressBarEl.style.width = `${percent}%`;
  }

  if (updateProgressLabelEl) {
    updateProgressLabelEl.textContent = "Baixando atualizacao";
  }
}

async function runUpdateCheck(mode: "auto" | "manual") {
  if (mode === "manual") {
    if (manualUpdateCheckButton) {
      manualUpdateCheckButton.disabled = true;
    }

    setManualUpdateStatus("Verificando atualizacoes...");
  }

  try {
    const result = await checkForUpdates();
    installedVersion = result.available ? result.update.currentVersion : result.currentVersion;
    renderInstalledVersion();

    if (result.available) {
      setManualUpdateStatus(`Nova versao disponivel: ${result.update.version}.`);
      renderUpdateModal(result.update);
      return;
    }

    if (mode === "manual") {
      setManualUpdateStatus("Voce ja esta utilizando a versao mais recente.");
    }
  } catch (error) {
    console.error("Falha ao verificar atualizacoes.", error);

    if (mode === "manual") {
      setManualUpdateStatus("Nao foi possivel verificar atualizacoes agora.");
    }
  } finally {
    if (mode === "manual" && manualUpdateCheckButton) {
      manualUpdateCheckButton.disabled = false;
    }
  }
}

async function updateNow() {
  if (!pendingUpdateInfo || updateInProgress) {
    return;
  }

  setUpdateInProgress(true);
  setUpdateError("");
  setUpdateProgress({ downloadedBytes: 0, contentLength: null, percent: 0 });

  try {
    await downloadAndInstallUpdate(setUpdateProgress);

    if (updateProgressLabelEl) {
      updateProgressLabelEl.textContent = "Atualizacao instalada";
    }

    await installUpdate();
  } catch (error) {
    console.error("Falha ao instalar atualizacao.", error);
    setUpdateError(
      "Nao foi possivel atualizar o Valtron. Voce pode continuar utilizando esta versao e tentar novamente mais tarde.",
    );
    setUpdateInProgress(false);
  }
}

function renderGridDetailsVisibility() {
  gridDetailsPanelEl?.classList.toggle("hidden", !gridDetailsVisible);

  if (toggleGridDetailsButton) {
    toggleGridDetailsButton.textContent = gridDetailsVisible ? "Ocultar detalhes" : "Detalhes";
  }
}

function setGridDetailsVisible(visible: boolean) {
  gridDetailsVisible = visible;
  renderGridDetailsVisibility();
}

function showLoading(message: string) {
  loadingCount += 1;

  if (loadingMessageEl) {
    loadingMessageEl.textContent = message;
  }

  loadingOverlayEl?.classList.remove("hidden");
  document.body.classList.add("is-loading");
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);

  if (loadingCount > 0) {
    return;
  }

  loadingOverlayEl?.classList.add("hidden");
  document.body.classList.remove("is-loading");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fileNameWithoutExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

function workspaceById(workspaceId: string | null) {
  if (!workspaceId) {
    return null;
  }

  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

function cellDisplayValue(value: CellValue) {
  return value === null ? "NULL" : value;
}

function cellDraftValue(value: CellValue) {
  return value === null ? "" : value;
}

function normalizedColumnType(columnName: string) {
  return (currentPage?.column_types?.[columnName] ?? "VARCHAR").toUpperCase();
}

function editorInputType(columnName: string) {
  const dataType = normalizedColumnType(columnName);

  if (dataType.includes("BOOL")) return "checkbox";
  if (dataType.includes("DATE") && !dataType.includes("TIME")) return "date";
  if (dataType.includes("TIMESTAMP") || dataType.includes("DATETIME")) return "datetime-local";
  if (
    dataType.includes("INT") ||
    dataType.includes("DECIMAL") ||
    dataType.includes("NUMERIC") ||
    dataType.includes("DOUBLE") ||
    dataType.includes("FLOAT") ||
    dataType.includes("REAL")
  ) {
    return "number";
  }

  return "text";
}

function cellCacheKey(rowId: string, columnName: string) {
  return `${rowId}\u0000${columnName}`;
}

function isSameCell(a: Pick<SelectedCellState, "rowId" | "columnName"> | null, b: Pick<SelectedCellState, "rowId" | "columnName"> | null) {
  return Boolean(a && b && a.rowId === b.rowId && a.columnName === b.columnName);
}

function rowIdForVisibleRow(rowIndex: number) {
  const offset = batchOffsetForRow(rowIndex);
  const rowIds = gridRowIdsCache.get(offset);
  const rowId = rowIds?.[rowIndex - offset];
  return rowId === null || rowId === undefined ? "" : String(rowId);
}

function updateCachedCell(rowIndex: number, visibleColumnIndex: number, value: CellValue) {
  const offset = batchOffsetForRow(rowIndex);
  const rows = gridRowsCache.get(offset);
  const row = rows?.[rowIndex - offset];

  if (!row || visibleColumnIndex < 0 || visibleColumnIndex >= row.length) {
    return false;
  }

  row[visibleColumnIndex] = value;
  return true;
}

function appendSqlHighlightText(fragment: DocumentFragment, text: string, className?: string) {
  if (!text) {
    return;
  }

  if (!className) {
    fragment.append(document.createTextNode(text));
    return;
  }

  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  fragment.append(span);
}

function buildSqlHighlightFragment(value: string) {
  const fragment = document.createDocumentFragment();
  const tokenPattern =
    /('(?:''|[^'])*')|\b(SELECT|FROM|WHERE|GROUP|BY|ORDER|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|WITH|COUNT|SUM|AVG|MIN|MAX|DISTINCT|CASE|WHEN|THEN|ELSE|END|HAVING|DESC|ASC|NULL|IS|LIKE|NOT|IN)\b|\b(\d+(?:\.\d+)?)\b/gi;
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    appendSqlHighlightText(fragment, value.slice(cursor, index));
    appendSqlHighlightText(
      fragment,
      match[0],
      match[1] ? "sql-token-string" : match[2] ? "sql-token-keyword" : "sql-token-number",
    );
    cursor = index + match[0].length;
  }

  appendSqlHighlightText(fragment, value.slice(cursor));
  fragment.append(document.createTextNode("\n"));
  return fragment;
}

function syncSqlHighlight() {
  if (!sqlQueryEl || !sqlHighlightEl) {
    return;
  }

  sqlHighlightEl.replaceChildren(buildSqlHighlightFragment(sqlQueryEl.value));
}

function sqlIdentifier(identifier: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

function currentSqlSource() {
  return sqlSources.find((source) => source.id === currentDocumentId) ?? sqlSources[0] ?? null;
}

function sqlContextPayload() {
  return {
    contextMode: sqlContextMode,
    workspaceId: currentWorkspaceId,
    documentId: sqlContextMode === "document" ? currentDocumentId : null,
  };
}

function sqlContextDocumentName(documentId: string | null | undefined) {
  if (!documentId) return null;
  return documents.find((document) => document.id === documentId)?.file_name ?? null;
}

function renderSqlContext() {
  if (sqlContextModeEl) {
    sqlContextModeEl.value = sqlContextMode;
  }

  if (!sqlContextLabelEl) {
    return;
  }

  if (sqlContextMode === "document") {
    const document = selectedDocument();
    sqlContextLabelEl.textContent = document ? `Documento: ${document.file_name}` : "Documento: nenhum selecionado";
    sqlContextLabelEl.title = document
      ? `ID logico: ${document.id}\nFonte fisica: ${document.table_name}`
      : "";
    return;
  }

  const workspace = selectedWorkspace();
  sqlContextLabelEl.textContent = workspace ? `Workspace: ${workspace.name}` : "Workspace: nenhum selecionado";
  sqlContextLabelEl.title = currentWorkspaceId ? `ID logico: ${currentWorkspaceId}` : "";
}

function activeSqlColumns() {
  if (sqlContextMode === "document") {
    return currentSqlSource()?.columns ?? currentPage?.columns ?? currentSummary?.columns ?? [];
  }

  return sqlSources.flatMap((source) => source.columns);
}

function activeSqlColumnType(column: string) {
  const sourceType = sqlSources.find((source) => source.column_types[column])?.column_types[column];
  return sourceType?.toUpperCase() ?? currentPage?.column_types?.[column]?.toUpperCase() ?? "VARCHAR";
}

function activeSqlTableName() {
  if (sqlContextMode === "document") {
    return "documento";
  }

  return null;
}

function sqlAliasesInQuery(query: string) {
  const aliases = new Set<string>();
  const aliasPattern = /\b(?:FROM|JOIN)\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi;

  for (const match of query.matchAll(aliasPattern)) {
    const alias = match[1];
    if (!SQL_KEYWORDS.some((keyword) => keyword.toLowerCase() === alias.toLowerCase())) {
      aliases.add(alias);
    }
  }

  return Array.from(aliases);
}

function readSqlHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SQL_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is SqlHistoryEntry => typeof entry?.id === "string" && typeof entry?.query === "string")
          .slice(0, SQL_HISTORY_LIMIT)
      : [];
  } catch (error) {
    return [];
  }
}

function writeSqlHistory() {
  localStorage.setItem(SQL_HISTORY_STORAGE_KEY, JSON.stringify(sqlHistory.slice(0, SQL_HISTORY_LIMIT)));
}

function readSavedSqlQueries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SQL_SAVED_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is SavedSqlQuery =>
            typeof entry?.id === "string" && typeof entry?.name === "string" && typeof entry?.query === "string",
        )
      : [];
  } catch (error) {
    return [];
  }
}

function writeSavedSqlQueries() {
  localStorage.setItem(SQL_SAVED_STORAGE_KEY, JSON.stringify(savedSqlQueries));
}

async function refreshSqlSources() {
  const requestSeq = ++sqlSourcesRequestSeq;

  if (!currentWorkspaceId || (sqlContextMode === "document" && !currentDocumentId)) {
    sqlSources = [];
    renderSqlContext();
    renderSqlAutocomplete();
    return;
  }

  try {
    const sources = await invoke<SqlSourceInfo[]>("list_sql_sources", sqlContextPayload());

    if (requestSeq !== sqlSourcesRequestSeq) {
      return;
    }

    sqlSources = sources;
  } catch (error) {
    if (requestSeq !== sqlSourcesRequestSeq) {
      return;
    }

    sqlSources = [];
    setStatus(String(error));
  } finally {
    if (requestSeq === sqlSourcesRequestSeq) {
      renderSqlContext();
      renderSqlAutocomplete();
    }
  }
}

function setSqlEditorValue(query: string) {
  if (!sqlQueryEl) return;
  sqlQueryEl.value = query;
  syncSqlHighlight();
  updateSqlAutocomplete();
  sqlQueryEl.focus();
}

function insertSqlText(text: string, range = sqlAutocompleteRange) {
  if (!sqlQueryEl) return;
  const start = range?.start ?? sqlQueryEl.selectionStart ?? sqlQueryEl.value.length;
  const end = range?.end ?? sqlQueryEl.selectionEnd ?? start;
  sqlQueryEl.setRangeText(text, start, end, "end");
  syncSqlHighlight();
  updateSqlAutocomplete();
  sqlQueryEl.focus();
}

function currentSqlToken() {
  if (!sqlQueryEl) return null;
  const end = sqlQueryEl.selectionStart ?? 0;
  const before = sqlQueryEl.value.slice(0, end);
  const match = before.match(/[A-Za-z0-9_\u00C0-\u017F" ]*$/);
  const raw = match?.[0] ?? "";
  const token = raw.replace(/^.*[\s,(=+\-*/]([A-Za-z0-9_\u00C0-\u017F"]*)$/, "$1");
  const start = end - token.length;
  return { token: token.replace(/^"/, ""), start, end };
}

function sqlSuggestionsForToken(token: string) {
  const normalized = token.toLowerCase();
  const tableName = activeSqlTableName();
  const columns = activeSqlColumns();
  const currentSource = currentSqlSource();
  const keywordSuggestions = SQL_KEYWORDS.map((keyword) => ({
    label: keyword,
    insertText: keyword,
    detail: "SQL",
    kind: "keyword" as const,
  }));
  const functionSuggestions = SQL_FUNCTIONS.map((fn) => ({
    label: fn,
    insertText: fn,
    detail: "DuckDB",
    kind: "function" as const,
  }));
  const aliasSuggestions = sqlContextMode === "workspace" && sqlQueryEl
    ? sqlAliasesInQuery(sqlQueryEl.value).map((alias) => ({
        label: alias,
        insertText: alias,
        detail: "Alias",
        kind: "table" as const,
      }))
    : [];
  const documentSuggestions =
    sqlContextMode === "document"
      ? tableName
        ? [
            {
              label: tableName,
              insertText: tableName,
              detail: currentSource?.name ?? "Documento atual",
              kind: "table" as const,
            },
            ...(currentSource
              ? [
                  {
                    label: currentSource.name,
                    insertText: sqlIdentifier(currentSource.name),
                    detail: "Nome logico",
                    kind: "table" as const,
                  },
                ]
              : []),
          ]
        : []
      : sqlSources.map((source) => ({
          label: source.name,
          insertText: sqlIdentifier(source.name),
          detail: "Documento",
          kind: "table" as const,
        }));
  const columnSuggestions = columns.map((column) => ({
    label: column,
    insertText: sqlIdentifier(column),
    detail: activeSqlColumnType(column),
    kind: "column" as const,
  }));
  const contextualSuggestions =
    sqlContextMode === "document"
      ? [...keywordSuggestions, ...documentSuggestions, ...columnSuggestions, ...functionSuggestions]
      : [...keywordSuggestions, ...documentSuggestions, ...aliasSuggestions, ...columnSuggestions, ...functionSuggestions];

  return contextualSuggestions
    .filter((suggestion) => !normalized || suggestion.label.toLowerCase().includes(normalized))
    .slice(0, 12);
}

function placeSqlFloatingPanel(panel: HTMLElement, anchor: HTMLElement | null) {
  if (!sqlShellEl || !anchor) return;
  const shellRect = sqlShellEl.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  panel.style.top = `${anchorRect.bottom - shellRect.top + 8}px`;
  panel.style.left = `${Math.max(12, anchorRect.left - shellRect.left)}px`;
}

function renderSqlAutocomplete() {
  if (!sqlAutocompleteEl) return;

  if (!sqlAutocompleteOpen || sqlAutocompleteItems.length === 0) {
    sqlAutocompleteEl.classList.add("hidden");
    sqlAutocompleteEl.innerHTML = "";
    return;
  }

  sqlAutocompleteEl.innerHTML = sqlAutocompleteItems
    .map(
      (item, index) => `
        <button class="sql-suggestion ${index === sqlAutocompleteIndex ? "active" : ""}" type="button" data-sql-suggestion="${index}" role="option" aria-selected="${index === sqlAutocompleteIndex}">
          <span>${escapeHtml(item.label)}</span>
          <small>${escapeHtml(item.detail)}</small>
        </button>
      `,
    )
    .join("");
  sqlAutocompleteEl.classList.remove("hidden");
}

function updateSqlAutocomplete() {
  const token = currentSqlToken();

  if (!token || token.token.length < 1 || !document.activeElement?.isSameNode(sqlQueryEl)) {
    sqlAutocompleteOpen = false;
    renderSqlAutocomplete();
    return;
  }

  sqlAutocompleteRange = { start: token.start, end: token.end };
  sqlAutocompleteItems = sqlSuggestionsForToken(token.token);
  sqlAutocompleteIndex = Math.min(sqlAutocompleteIndex, Math.max(0, sqlAutocompleteItems.length - 1));
  sqlAutocompleteOpen = sqlAutocompleteItems.length > 0;
  renderSqlAutocomplete();
}

function applySqlSuggestion(index = sqlAutocompleteIndex) {
  const suggestion = sqlAutocompleteItems[index];

  if (!suggestion) return;

  insertSqlText(suggestion.insertText);
  sqlAutocompleteOpen = false;
  renderSqlAutocomplete();
}

function closeSqlPopover() {
  sqlPopoverMode = null;
  sqlPopoverEl?.classList.add("hidden");
  if (sqlPopoverEl) {
    sqlPopoverEl.innerHTML = "";
  }
}

function renderSqlPopover() {
  if (!sqlPopoverEl || !sqlPopoverMode) return;

  if (sqlPopoverMode === "columns") {
    const search = sqlColumnSearch.toLowerCase();
    const sources = sqlSources
      .map((source) => ({
        ...source,
        columns: source.columns.filter(
          (column) =>
            !search ||
            column.toLowerCase().includes(search) ||
            (sqlContextMode === "workspace" && source.name.toLowerCase().includes(search)),
        ),
      }))
      .filter((source) => source.columns.length > 0 || (sqlContextMode === "workspace" && source.name.toLowerCase().includes(search)));
    const totalColumns = sources.reduce((total, source) => total + source.columns.length, 0);
    sqlPopoverEl.innerHTML = `
      <div class="sql-popover-header">
        <strong>${escapeHtml(sqlContextMode === "document" ? currentSqlSource()?.name ?? "Colunas" : "Colunas")}</strong>
        <span>${formatNumber(totalColumns)}</span>
      </div>
      <input id="sql-column-search" class="sql-popover-search" placeholder="${sqlContextMode === "document" ? "Buscar coluna" : "Buscar documento ou coluna"}" value="${escapeHtml(sqlColumnSearch)}" />
      <div class="sql-popover-list">
        ${
          totalColumns > 0
            ? sources
                .map((source) =>
                  sqlContextMode === "workspace"
                    ? `
                      <div class="sql-source-group">
                        <button class="sql-popover-item sql-source-name" type="button" data-insert-source="${escapeHtml(source.name)}" title="${escapeHtml(source.name)}">
                          <span>${escapeHtml(source.name)}</span>
                          <small>${formatNumber(source.columns.length)} colunas</small>
                        </button>
                        ${source.columns
                          .map(
                            (column) => `
                              <button class="sql-popover-item nested" type="button" data-insert-column="${escapeHtml(column)}" title="${escapeHtml(column)}&#10;${escapeHtml(source.column_types[column]?.toUpperCase() ?? "VARCHAR")}">
                                <span>${escapeHtml(column)}</span>
                                <small>${escapeHtml(source.column_types[column]?.toUpperCase() ?? "VARCHAR")}</small>
                              </button>
                            `,
                          )
                          .join("")}
                      </div>
                    `
                    : source.columns
                        .map(
                          (column) => `
                            <button class="sql-popover-item" type="button" data-insert-column="${escapeHtml(column)}" title="${escapeHtml(column)}&#10;${escapeHtml(source.column_types[column]?.toUpperCase() ?? activeSqlColumnType(column))}">
                              <span>${escapeHtml(column)}</span>
                              <small>${escapeHtml(source.column_types[column]?.toUpperCase() ?? activeSqlColumnType(column))}</small>
                            </button>
                          `,
                        )
                        .join(""),
                )
                .join("")
            : '<p class="sql-popover-empty">Nenhuma coluna encontrada.</p>'
        }
      </div>
    `;
    placeSqlFloatingPanel(sqlPopoverEl, sqlColumnsButton);
  } else if (sqlPopoverMode === "history") {
    sqlPopoverEl.innerHTML = `
      <div class="sql-popover-header"><strong>Historico</strong><span>${formatNumber(sqlHistory.length)}</span></div>
      <div class="sql-popover-list">
        ${
          sqlHistory.length
            ? sqlHistory
                .map(
                  (entry) => `
                    <button class="sql-popover-item stacked" type="button" data-load-history="${escapeHtml(entry.id)}">
                      <span>${escapeHtml(formatSqlHistoryTime(entry.executedAt))}</span>
                      <code>${escapeHtml(compactSql(entry.query))}</code>
                      <small>${entry.error ? "Erro" : `${formatNumber(entry.rowCount ?? 0)} linhas${entry.durationMs !== null ? ` - ${formatDuration(entry.durationMs)}` : ""}`}</small>
                    </button>
                  `,
                )
                .join("")
            : '<p class="sql-popover-empty">Nenhuma consulta executada.</p>'
        }
      </div>
    `;
    placeSqlFloatingPanel(sqlPopoverEl, sqlHistoryButton);
  } else if (sqlPopoverMode === "saved") {
    sqlPopoverEl.innerHTML = `
      <div class="sql-popover-header">
        <strong>Salvas</strong>
        <button class="ghost-button compact-button" type="button" data-save-current-query>Salvar consulta</button>
      </div>
      <div class="sql-popover-list">
        ${
          savedSqlQueries.length
            ? savedSqlQueries
                .map(
                  (entry) => `
                    <button class="sql-popover-item stacked" type="button" data-load-saved="${escapeHtml(entry.id)}">
                      <span>${escapeHtml(entry.name)}</span>
                      <code>${escapeHtml(compactSql(entry.query))}</code>
                    </button>
                  `,
                )
                .join("")
            : '<p class="sql-popover-empty">Nenhuma consulta salva.</p>'
        }
      </div>
    `;
    placeSqlFloatingPanel(sqlPopoverEl, sqlSavedButton);
  } else {
    sqlPopoverEl.innerHTML = `
      <div class="sql-popover-list compact">
        <button class="sql-popover-item" type="button" data-sql-menu-action="format">Formatar SQL</button>
        <button class="sql-popover-item" type="button" data-sql-menu-action="save">Salvar consulta</button>
        <button class="sql-popover-item" type="button" data-sql-menu-action="copy">Copiar SQL</button>
      </div>
    `;
    placeSqlFloatingPanel(sqlPopoverEl, sqlMenuButton);
  }

  sqlPopoverEl.classList.remove("hidden");
  sqlPopoverEl.querySelector<HTMLInputElement>("#sql-column-search")?.focus();
}

function toggleSqlPopover(mode: typeof sqlPopoverMode) {
  if (sqlPopoverMode === mode) {
    closeSqlPopover();
    return;
  }

  sqlPopoverMode = mode;
  renderSqlPopover();
}

function formatSqlHistoryTime(value: number) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function compactSql(query: string) {
  return query.replace(/\s+/g, " ").trim().slice(0, 140);
}

function recordSqlHistory(query: string, page: TablePage | null, durationMs: number | null, error: string | null) {
  sqlHistory = [
    {
      id: `sql_${Date.now()}`,
      query,
      contextMode: sqlContextMode,
      documentId: sqlContextMode === "document" ? currentDocumentId : null,
      workspaceId: currentWorkspaceId,
      executedAt: Date.now(),
      rowCount: page?.total_rows ?? null,
      durationMs,
      error,
    },
    ...sqlHistory.filter((entry) => entry.query !== query),
  ].slice(0, SQL_HISTORY_LIMIT);
  writeSqlHistory();
}

function restoreSqlEntryContext(entry: Pick<SqlHistoryEntry, "contextMode" | "documentId" | "workspaceId">) {
  if (entry.contextMode === "document" || entry.contextMode === "workspace") {
    sqlContextMode = entry.contextMode;
  }

  if (entry.contextMode === "document" && entry.documentId && documents.some((document) => document.id === entry.documentId)) {
    currentDocumentId = entry.documentId;
    renderDocuments();
  }

  renderSqlContext();
  refreshSqlSources().catch((error) => setStatus(String(error)));
}

function friendlySqlError(error: unknown): SqlFriendlyError {
  const technical = String(error);
  const candidateMatch = technical.match(/Candidate bindings:\s*([\s\S]+)/i);
  const firstCandidate = candidateMatch?.[1]?.match(/"([^"]+)"/)?.[1];
  const missingMatch = technical.match(/Referenced column "([^"]+)"/i);

  if (missingMatch) {
    const missing = missingMatch[1];
    return {
      title: "Coluna nao encontrada",
      message: `"${missing}" nao existe neste documento.`,
      suggestion: firstCandidate ? `"${firstCandidate}"` : nearestSqlColumn(missing),
      technical,
    };
  }

  return {
    title: "Nao foi possivel executar a consulta",
    message: "Revise a sintaxe SQL e os nomes de tabela ou coluna.",
    technical,
  };
}

function nearestSqlColumn(value: string) {
  const normalized = normalizeSqlText(value);
  return (
    activeSqlColumns()
      .map((column) => ({ column, distance: levenshtein(normalizeSqlText(column), normalized) }))
      .sort((left, right) => left.distance - right.distance)[0]?.column ?? null
  );
}

function normalizeSqlText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "")
    .toLowerCase();
}

function levenshtein(left: string, right: string) {
  const dp = Array.from({ length: left.length + 1 }, (_row, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) dp[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      dp[row][column] =
        left[row - 1] === right[column - 1]
          ? dp[row - 1][column - 1]
          : Math.min(dp[row - 1][column - 1], dp[row][column - 1], dp[row - 1][column]) + 1;
    }
  }
  return dp[left.length][right.length];
}

function renderSqlError(error: SqlFriendlyError | null) {
  lastSqlFriendlyError = error;

  if (!sqlErrorEl || !error) {
    sqlErrorEl?.classList.add("hidden");
    if (sqlErrorEl) sqlErrorEl.innerHTML = "";
    return;
  }

  sqlErrorEl.innerHTML = `
    <div>
      <strong>${escapeHtml(error.title)}</strong>
      <p>${escapeHtml(error.message)}</p>
      ${error.suggestion ? `<p>Voce quis dizer ${escapeHtml(error.suggestion)}?</p>` : ""}
    </div>
    <div class="sql-error-actions">
      ${error.suggestion ? '<button class="ghost-button compact-button" type="button" data-sql-fix>Substituir</button>' : ""}
      <details>
        <summary>Ver detalhes</summary>
        <pre>${escapeHtml(error.technical)}</pre>
      </details>
    </div>
  `;
  sqlErrorEl.classList.remove("hidden");
}

function applySqlErrorFix() {
  if (!sqlQueryEl || !lastSqlFriendlyError?.suggestion) return;
  const missingMatch = lastSqlFriendlyError.technical.match(/Referenced column "([^"]+)"/i);
  const missing = missingMatch?.[1];
  const suggestion = lastSqlFriendlyError.suggestion;

  if (!missing) return;

  const escapedMissing = missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  sqlQueryEl.value = sqlQueryEl.value.replace(new RegExp(`"${escapedMissing}"|\\b${escapedMissing}\\b`, "g"), suggestion);
  syncSqlHighlight();
  renderSqlError(null);
  sqlQueryEl.focus();
}

function formatSqlQuery() {
  if (!sqlQueryEl) return;
  const formatted = sqlQueryEl.value
    .replace(/\s+/g, " ")
    .replace(/\b(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET)\b/gi, "\n$1")
    .replace(/\b(AND|OR)\b/gi, "\n  $1")
    .trim();
  setSqlEditorValue(formatted);
}

function openSqlSaveModal(mode: "query" | "result") {
  if (!sqlSaveModalEl || !sqlSaveNameEl || !sqlSaveTitleEl || !sqlSaveEyebrowEl || !sqlSaveNameLabelEl) return;
  sqlSaveMode = mode;
  sqlSaveEyebrowEl.textContent = mode === "query" ? "Consulta SQL" : "Resultado SQL";
  sqlSaveTitleEl.textContent = mode === "query" ? "Salvar consulta" : "Salvar resultado";
  sqlSaveNameLabelEl.textContent = "Nome";
  sqlSaveNameEl.value = "";
  sqlSaveErrorEl?.classList.add("hidden");
  sqlSaveModalEl.classList.remove("hidden");
  sqlSaveNameEl.focus();
}

function closeSqlSaveModal() {
  sqlSaveMode = null;
  sqlSaveModalEl?.classList.add("hidden");
  if (sqlSaveErrorEl) {
    sqlSaveErrorEl.textContent = "";
    sqlSaveErrorEl.classList.add("hidden");
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function formatImportedAt(value: string) {
  const millis = Number(value);

  if (!Number.isFinite(millis)) {
    return "-";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(millis));
}

function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "Nao disponivel";
  }

  if (value < 1000) {
    return `${formatNumber(Math.round(value))} ms`;
  }

  const seconds = value / 1000;

  if (seconds < 60) {
    return `${new Intl.NumberFormat("pt-BR", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    }).format(seconds)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${formatNumber(minutes)} min ${formatNumber(remainingSeconds)} s`;
}

function exportExtension(format: ExportFormat) {
  if (format === "xlsx") {
    return "xlsx";
  }

  return format === "tsv" ? "tsv" : "csv";
}

function exportDelimiterName(format: ExportFormat) {
  if (format === "xlsx") {
    return "XLSX";
  }

  return format === "tsv" ? "TSV" : "CSV";
}

function sanitizeFileName(value: string) {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "");

  return sanitized || "documento";
}

function renderPerformanceRows(performance: ImportPerformance | null) {
  if (!performance) {
    return `
      <div>
        <dt>Tempo por etapa</dt>
        <dd>Nao disponivel para importacoes antigas.</dd>
      </div>
    `;
  }

  const rows: Array<[string, string]> = [
    ["Estrategia", performance.import_strategy ?? "Nao registrada"],
    ["Metodo XLSX DuckDB", performance.duckdb_xlsx_method || "Nao aplicado"],
    ["Opcoes XLSX DuckDB", performance.duckdb_xlsx_options || "Nao aplicadas"],
    ["Abertura do arquivo", formatDuration(performance.file_open_ms)],
    ["Abertura/descompactacao XLSX", formatDuration(performance.xlsx_open_ms)],
    ["Leitura/parse da planilha", formatDuration(performance.worksheets_read_ms)],
    ["Inspecao do workbook", formatDuration(performance.excel_workbook_inspection_ms ?? 0)],
    ["Deteccao de cabecalho", formatDuration(performance.excel_header_detection_ms ?? 0)],
    ["Importacao da planilha", formatDuration(performance.excel_sheet_import_ms ?? 0)],
    ["Total Excel", formatDuration(performance.excel_total_import_ms ?? 0)],
    ["Geracao CSV", formatDuration(performance.csv_generation_ms ?? 0)],
    ["Tamanho do batch", formatNumber(performance.batch_size ?? 0)],
    ["Quantidade de batches", formatNumber(performance.batch_count ?? 0)],
    ["Montagem dos batches", formatDuration(performance.batch_build_total_ms ?? 0)],
    ["Montagem media por batch", formatDuration(performance.batch_build_avg_ms ?? 0)],
    ["Conversao de celulas", formatDuration(performance.cell_conversion_ms)],
    ["Validacao", formatDuration(performance.validation_ms)],
    ["Preparacao dos dados", formatDuration(performance.data_preparation_ms)],
    ["DuckDB total", formatDuration(performance.duckdb_ms)],
    ["DuckDB limpeza da tabela", formatDuration(performance.duckdb_table_cleanup_ms)],
    ["DuckDB criacao/importacao", formatDuration(performance.duckdb_table_creation_ms)],
    ["DuckDB XLSX import", formatDuration(performance.duckdb_xlsx_import_ms ?? 0)],
    ["DuckDB COPY", formatDuration(performance.duckdb_copy_ms ?? 0)],
    ["DuckDB Arrow", formatDuration(performance.duckdb_arrow_ingestion_ms ?? 0)],
    ["DuckDB Arrow medio", formatDuration(performance.duckdb_arrow_ingestion_avg_ms ?? 0)],
    ["DuckDB appender/insert", formatDuration(performance.duckdb_appender_ms)],
    ["DuckDB flush", formatDuration(performance.duckdb_flush_ms)],
    ["DuckDB commit", formatDuration(performance.duckdb_commit_ms)],
    ["DuckDB consultas finais", formatDuration(performance.duckdb_final_queries_ms)],
    ["Estruturas auxiliares", formatDuration(performance.auxiliary_structures_ms)],
    ["Espera parser pipeline", formatDuration(performance.pipeline_wait_parser_ms ?? 0)],
    ["Espera DuckDB pipeline", formatDuration(performance.pipeline_wait_duckdb_ms ?? 0)],
    ["Pico de memoria", `${formatNumber(performance.peak_memory_mb ?? 0)} MB`],
    ["Total medido", formatDuration(performance.total_ms)],
  ];

  return rows
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join("");
}

function selectedDocument() {
  return documents.find((document) => document.id === currentDocumentId) ?? null;
}

function detailsDocument() {
  return documents.find((document) => document.id === detailsDocumentId) ?? null;
}

function activeFilters(): ColumnFilter[] {
  return Array.from(filterValues.values()).filter(
    (filter) =>
      filter.operator === "empty" ||
      filter.operator === "quality_violation" ||
      filter.value.trim().length > 0,
  );
}

function columnVisibilityStorageKey(documentId: string) {
  return `${COLUMN_VISIBILITY_STORAGE_PREFIX}.${documentId}`;
}

function readHiddenColumns(documentId: string | null) {
  if (!documentId) {
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(columnVisibilityStorageKey(documentId)) ?? "[]");

    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(parsed.filter((column): column is string => typeof column === "string"));
  } catch (error) {
    console.error("Falha ao ler configuracao de colunas.", error);
    return new Set<string>();
  }
}

function writeHiddenColumns(documentId: string, hiddenColumns: Set<string>) {
  const key = columnVisibilityStorageKey(documentId);

  if (hiddenColumns.size === 0) {
    localStorage.removeItem(key);
    return;
  }

  localStorage.setItem(key, JSON.stringify(Array.from(hiddenColumns)));
}

function columnWidthStorageKey() {
  const scope =
    dataMode === "sql"
      ? `sql.${currentSqlQuery ?? ""}`
      : currentDocumentId
        ? `document.${currentDocumentId}`
        : "empty";

  return `${COLUMN_WIDTH_STORAGE_PREFIX}.${scope}`;
}

function clampColumnWidth(width: number, max = COLUMN_WIDTH_CONFIG.resizeMax) {
  return Math.round(Math.min(max, Math.max(COLUMN_WIDTH_CONFIG.min, width)));
}

function readColumnPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(columnWidthStorageKey()) ?? "{}");

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map<string, ColumnPreferences>();
    }

    return new Map(
      Object.entries(parsed)
        .filter((entry): entry is [string, ColumnPreferences] => {
          const [, value] = entry;
          return Boolean(value) && typeof value === "object" && !Array.isArray(value);
        })
        .map(([column, preference]) => [
          column,
          {
            ...preference,
            width:
              typeof preference.width === "number"
                ? clampColumnWidth(preference.width)
                : undefined,
          },
        ]),
    );
  } catch (error) {
    console.error("Falha ao ler larguras das colunas.", error);
    return new Map<string, ColumnPreferences>();
  }
}

function writeColumnPreferences() {
  const entries = Array.from(columnPreferences.entries()).filter(([, preference]) =>
    Object.values(preference).some((value) => value !== undefined && value !== null),
  );

  if (entries.length === 0) {
    localStorage.removeItem(columnWidthStorageKey());
    return;
  }

  localStorage.setItem(columnWidthStorageKey(), JSON.stringify(Object.fromEntries(entries)));
}

function normalizeColumnName(column: string) {
  return column
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function inferredInitialColumnWidth(column: string) {
  const normalized = normalizeColumnName(column);

  if (/\b(cpf|cnpj)\b/.test(normalized)) {
    return 140;
  }

  if (normalized.includes("municipio") || normalized.includes("cidade")) {
    return 180;
  }

  if (normalized.includes("descricao") || normalized.includes("observacao") || normalized.includes("historico")) {
    return 320;
  }

  if (normalized.includes("nome") || normalized.includes("razao")) {
    return 280;
  }

  const estimated = Math.max(COLUMN_WIDTH_CONFIG.default, column.length * 9 + COLUMN_WIDTH_CONFIG.headerPadding);
  return clampColumnWidth(estimated, COLUMN_WIDTH_CONFIG.maxInitial);
}

function columnWidth(column: string) {
  return columnPreferences.get(column)?.width ?? inferredInitialColumnWidth(column);
}

function setColumnWidth(column: string, width: number, persist = true) {
  const previous = columnPreferences.get(column) ?? {};
  columnPreferences.set(column, {
    ...previous,
    width: clampColumnWidth(width),
  });

  if (persist) {
    writeColumnPreferences();
  }
}

function gridColumnsWidth(visibleColumns: VisibleColumnEntry[]) {
  return visibleColumns.reduce((total, { column }) => total + columnWidth(column), GRID_ROW_NUMBER_WIDTH);
}

function applyGridColumnWidths(visibleColumns: VisibleColumnEntry[]) {
  if (!tableViewportEl || !tableHeadEl || !tableBodyEl) {
    return;
  }

  visibleColumns.forEach(({ column }, visibleIndex) => {
    tableViewportEl.style.setProperty(`--grid-col-${visibleIndex}`, `${columnWidth(column)}px`);
  });

  const minWidth = `${gridColumnsWidth(visibleColumns)}px`;
  tableHeadEl.style.minWidth = minWidth;
  tableBodyEl.style.minWidth = minWidth;
}

function hiddenColumnsForCurrentGrid() {
  return dataMode === "document" ? readHiddenColumns(currentDocumentId) : new Set<string>();
}

function visibleColumnEntries(page: TablePage): VisibleColumnEntry[] {
  const hiddenColumns = hiddenColumnsForCurrentGrid();
  const entries = page.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !hiddenColumns.has(column));

  return entries.length > 0 ? entries : page.columns.map((column, index) => ({ column, index }));
}

function visibleColumnCount(page: TablePage | null = currentPage) {
  return page ? visibleColumnEntries(page).length : 0;
}

function currentVisibleColumnNames() {
  return currentPage ? visibleColumnEntries(currentPage).map(({ column }) => column) : [];
}

function resetGridCache() {
  gridRequestSeq += 1;
  gridRowsCache = new Map();
  gridRowIdsCache = new Map();
  gridLoadingOffsets = new Set();
  gridKnownTotalRows = 0;
  gridSignature = "";
  gridLoading = false;
  selectedCell = null;
  activeCellEdit = null;
  hideCellPopover();
  if (tableViewportEl) tableViewportEl.scrollTop = 0;
}

function gridStateSignature() {
  return JSON.stringify({
    mode: dataMode,
    documentId: currentDocumentId,
    query: currentSqlQuery,
    filters: activeFilters(),
    sortColumn,
    sortDirection,
    columns: currentVisibleColumnNames(),
  });
}

function batchOffsetForRow(rowIndex: number) {
  return Math.max(0, Math.floor(rowIndex / GRID_BATCH_SIZE) * GRID_BATCH_SIZE);
}

function sortedCacheOffsets() {
  return Array.from(gridRowsCache.keys()).sort((a, b) => a - b);
}

function pruneGridCache(anchorOffset: number) {
  const offsets = sortedCacheOffsets();

  while (offsets.length > GRID_MAX_CACHED_BATCHES) {
    const farthest = offsets.reduce((selected, offset) =>
      Math.abs(offset - anchorOffset) > Math.abs(selected - anchorOffset) ? offset : selected,
    offsets[0]);
    gridRowsCache.delete(farthest);
    gridRowIdsCache.delete(farthest);
    offsets.splice(offsets.indexOf(farthest), 1);
  }
}

function setGridLoading(loading: boolean) {
  gridLoading = loading;
  if (gridLoadingStatusEl) {
    gridLoadingStatusEl.textContent = loading ? "Carregando lote..." : "";
  }
}

function visibleRowBounds() {
  const viewportHeight = tableViewportEl?.clientHeight ?? 0;
  const scrollTop = tableViewportEl?.scrollTop ?? 0;
  const headerHeight = tableHeadEl?.getBoundingClientRect().height ?? 0;
  const effectiveTop = Math.max(0, scrollTop - headerHeight);
  const start = Math.max(0, Math.floor(effectiveTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN_ROWS);
  const end = Math.min(
    gridKnownTotalRows,
    Math.ceil((effectiveTop + viewportHeight) / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS,
  );

  return { start, end };
}

function cachedRow(rowIndex: number) {
  const offset = batchOffsetForRow(rowIndex);
  const rows = gridRowsCache.get(offset);
  return rows?.[rowIndex - offset] ?? null;
}

function filterValue(column: string) {
  const filter = filterValues.get(column);
  return !filter || filter.operator === "empty" || filter.operator === "quality_violation" ? "" : filter.value;
}

function activeFilterLabel(column: string) {
  const filter = filterValues.get(column);

  if (!filter) {
    return null;
  }

  if (filter.operator === "empty") {
    return "Vazios";
  }

  if (filter.operator === "quality_violation") {
    const rule = qualityState.rules.find((item) => item.id === filter.rule_id);
    return rule ? `Violacoes: ${rule.name}` : "Violacoes de qualidade";
  }

  return filter.value;
}

function setContainsFilter(column: string, value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    filterValues.delete(column);
    return;
  }

  filterValues.set(column, {
    column,
    operator: "contains",
    value: trimmed,
  });
}

function setEqualsFilter(column: string, value: string) {
  filterValues.set(column, {
    column,
    operator: "equals",
    value,
  });
}

function setEmptyFilter(column: string) {
  filterValues.set(column, {
    column,
    operator: "empty",
    value: "",
  });
}

function setQualityRuleFilter(rule: QualityRule) {
  filterValues.set(rule.column_name, {
    column: rule.column_name,
    operator: "quality_violation",
    value: "",
    rule_id: rule.id,
  });
}

function qualityHeaderHint(column: string) {
  if (
    profilingState.documentId === currentDocumentId &&
    profilingState.column === column &&
    qualityState.status === "ready" &&
    qualityState.summary &&
    qualityState.rules.length > 0
  ) {
    return `Qualidade ${formatNumber(Math.round(qualityState.summary.score))}%`;
  }

  return "";
}

function renameColumnInLocalState(oldColumn: string, newColumn: string) {
  const activeFilter = filterValues.get(oldColumn);

  if (activeFilter !== undefined) {
    filterValues.delete(oldColumn);
    filterValues.set(newColumn, {
      ...activeFilter,
      column: newColumn,
    });
  }

  if (sortColumn === oldColumn) {
    sortColumn = newColumn;
  }

  const columnPreference = columnPreferences.get(oldColumn);

  if (columnPreference) {
    columnPreferences.delete(oldColumn);
    columnPreferences.set(newColumn, columnPreference);
    writeColumnPreferences();
  }

  if (currentSummary) {
    currentSummary = {
      ...currentSummary,
      columns: currentSummary.columns.map((column) => (column === oldColumn ? newColumn : column)),
    };
  }

  if (currentPage) {
    currentPage = {
      ...currentPage,
      columns: currentPage.columns.map((column) => (column === oldColumn ? newColumn : column)),
      filters: currentPage.filters.map((filter) =>
        filter.column === oldColumn ? { ...filter, column: newColumn } : filter,
      ),
      stats: {
        ...currentPage.stats,
        quality: currentPage.stats.quality.map((item) =>
          item.column === oldColumn ? { ...item, column: newColumn } : item,
        ),
      },
      sort_column: currentPage.sort_column === oldColumn ? newColumn : currentPage.sort_column,
    };
  }

  if (currentDocumentId) {
    const hiddenColumns = readHiddenColumns(currentDocumentId);

    if (hiddenColumns.has(oldColumn)) {
      hiddenColumns.delete(oldColumn);
      hiddenColumns.add(newColumn);
      writeHiddenColumns(currentDocumentId, hiddenColumns);
    }
  }
}

function sortIndicator(column: string) {
  if (sortColumn !== column) {
    return "";
  }

  return sortDirection === "desc" ? "↓" : "↑";
}

function renderSidebarState() {
  appShellEl?.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebarToggleButton?.setAttribute(
    "aria-label",
    sidebarCollapsed ? "Expandir menu lateral de documentos" : "Recolher menu lateral",
  );
  sidebarToggleButton?.setAttribute(
    "title",
    sidebarCollapsed ? "Abrir documentos" : "Recolher menu",
  );
  sidebarToggleButton?.setAttribute("aria-expanded", String(!sidebarCollapsed));
}

function setOpenDocumentMenu(documentId: string | null) {
  openDocumentMenuId = documentId;
  renderDocuments();
  renderDocumentActionMenu();
}

function renderDocumentActionMenu() {
  if (!documentActionMenuEl) {
    return;
  }

  if (!openDocumentMenuId) {
    documentActionMenuEl.classList.remove("open");
    documentActionMenuEl.innerHTML = "";
    return;
  }

  documentActionMenuEl.style.top = `${documentMenuPosition.top}px`;
  documentActionMenuEl.style.left = `${documentMenuPosition.left}px`;
  documentActionMenuEl.innerHTML = `
    <button
      class="document-menu-detail"
      type="button"
      data-details-document-id="${escapeHtml(openDocumentMenuId)}"
      aria-label="Detalhes"
      title="Detalhes"
    ><span aria-hidden="true">&#9432;</span><strong>Detalhes</strong></button>
    <button
      class="document-menu-rename"
      type="button"
      data-rename-document-id="${escapeHtml(openDocumentMenuId)}"
      aria-label="Renomear documento"
      title="Renomear documento"
    >
      <span aria-hidden="true">&#9998;</span>
      <strong>Renomear</strong>
    </button>
    <button
      class="document-menu-export"
      type="button"
      data-export-document-id="${escapeHtml(openDocumentMenuId)}"
      aria-label="Exportar documento"
      title="Exportar documento"
    >
      <span aria-hidden="true">&#8681;</span>
      <strong>Exportar</strong>
    </button>
    <button
      class="document-menu-delete"
      type="button"
      data-delete-document-id="${escapeHtml(openDocumentMenuId)}"
      aria-label="Excluir documento"
      title="Excluir documento"
    >
      <span aria-hidden="true">&#128465;</span>
      <strong>Excluir</strong>
    </button>
  `;
  documentActionMenuEl.classList.add("open");
}

function setOpenColumnMenu(menu: { column: string; index: number } | null) {
  openColumnMenu = menu;
  renderColumnActionMenu();
}

function renderColumnActionMenu() {
  if (!columnActionMenuEl) {
    return;
  }

  if (!openColumnMenu || dataMode !== "document") {
    columnActionMenuEl.classList.remove("open");
    columnActionMenuEl.innerHTML = "";
    return;
  }

  const column = openColumnMenu.column;
  columnActionMenuEl.style.top = `${columnMenuPosition.top}px`;
  columnActionMenuEl.style.left = `${columnMenuPosition.left}px`;
  columnActionMenuEl.innerHTML = `
    <button type="button" data-column-menu-action="sort-asc">Ordenar crescente</button>
    <button type="button" data-column-menu-action="sort-desc">Ordenar decrescente</button>
    <button type="button" data-column-menu-action="focus-filter">Filtrar</button>
    <hr />
    <button type="button" data-column-menu-action="profile">Analisar coluna</button>
    <button type="button" data-column-menu-action="quality">Qualidade</button>
    <button type="button" data-column-menu-action="transform">Transformar</button>
    <hr />
    <button type="button" data-column-menu-action="rename">Renomear</button>
    <button type="button" data-column-menu-action="hide">Ocultar</button>
  `;
  columnActionMenuEl.classList.add("open");
  columnActionMenuEl.setAttribute("aria-label", `Opcoes da coluna ${column}`);
}

function focusColumnFilter(column: string) {
  const input = Array.from(
    tableHeadEl?.querySelectorAll<HTMLInputElement>("[data-filter-column]") ?? [],
  ).find((item) => item.dataset.filterColumn === column);
  input?.focus();
}

function renderDetailsModal() {
  if (!detailsModalEl || !detailsContentEl) {
    return;
  }

  const document = detailsDocument();

  if (!document) {
    detailsModalEl.classList.add("hidden");
    detailsContentEl.innerHTML = "";
    return;
  }

  detailsContentEl.innerHTML = `
    <dl>
      <div>
        <dt>Documento</dt>
        <dd>${escapeHtml(document.file_name)}</dd>
      </div>
      <div>
        <dt>Planilha/origem</dt>
        <dd>${escapeHtml(document.sheet_name)}</dd>
      </div>
      <div>
        <dt>Importado em</dt>
        <dd>${escapeHtml(formatImportedAt(document.imported_at))}</dd>
      </div>
      <div>
        <dt>Linhas no momento da importacao</dt>
        <dd>${formatNumber(document.row_count)}</dd>
      </div>
      <div>
        <dt>Colunas importadas</dt>
        <dd>${formatNumber(document.column_count)}</dd>
      </div>
      <div>
        <dt>Duracao total da importacao</dt>
        <dd>${escapeHtml(formatDuration(document.import_duration_ms))}</dd>
      </div>
      ${renderPerformanceRows(document.import_performance)}
    </dl>
  `;
  detailsModalEl.classList.remove("hidden");
}

function openDetails(documentId: string) {
  detailsDocumentId = documentId;
  setOpenDocumentMenu(null);
  renderDetailsModal();
}

function closeDetails() {
  detailsDocumentId = null;
  renderDetailsModal();
}

function renameDocument() {
  return documents.find((document) => document.id === renameDocumentId) ?? null;
}

function openRename(documentId: string) {
  const document = documents.find((item) => item.id === documentId);

  if (!document || !renameModalEl || !renameDocumentNameEl) {
    setStatus("Documento nao encontrado para renomear.");
    return;
  }

  renameDocumentId = documentId;
  renameDocumentNameEl.value = document.file_name;
  setOpenDocumentMenu(null);
  renameModalEl.classList.remove("hidden");
  renameDocumentNameEl.focus();
  renameDocumentNameEl.select();
}

function closeRename() {
  renameDocumentId = null;
  renameModalEl?.classList.add("hidden");
  if (renameDocumentNameEl) {
    renameDocumentNameEl.value = "";
  }
}

function openRenameColumn(columnIndex: number) {
  if (dataMode !== "document" || !currentDocumentId || !currentPage || !renameColumnModalEl || !renameColumnNameEl) {
    setStatus("Selecione um documento para renomear colunas.");
    return;
  }

  const column = currentPage.columns[columnIndex];

  if (!column) {
    setStatus("Coluna nao encontrada para renomear.");
    return;
  }

  renameColumnName = column;
  renameColumnIndex = columnIndex;
  renameColumnNameEl.value = column;
  renameColumnModalEl.classList.remove("hidden");
  renameColumnNameEl.focus();
  renameColumnNameEl.select();
}

function closeRenameColumn() {
  renameColumnName = null;
  renameColumnIndex = null;
  renameColumnModalEl?.classList.add("hidden");
  if (renameColumnNameEl) {
    renameColumnNameEl.value = "";
  }
}

async function saveRenameColumn() {
  const columnIndex = renameColumnIndex;
  const oldColumn = columnIndex === null ? null : currentPage?.columns[columnIndex] ?? renameColumnName;
  const newColumn = renameColumnNameEl?.value.trim() ?? "";

  if (!currentDocumentId || columnIndex === null || !oldColumn || !renameColumnNameEl || !saveRenameColumnButton) {
    setStatus("Coluna nao encontrada para renomear.");
    return;
  }

  if (!newColumn) {
    setStatus("Digite um nome para a coluna.");
    renameColumnNameEl.focus();
    return;
  }

  saveRenameColumnButton.disabled = true;
  setStatus("Renomeando coluna...");

  try {
    await invoke<string[]>("rename_document_column", {
      documentId: currentDocumentId,
      columnIndex,
      newColumn,
    });

    profilingCache.renameColumn(currentDocumentId, oldColumn, newColumn);
    if (profilingState.documentId === currentDocumentId && profilingState.column === oldColumn) {
      profilingState = {
        ...profilingState,
        column: newColumn,
        profile: profilingState.profile ? { ...profilingState.profile, column: newColumn } : null,
      };
      qualityState = {
        ...qualityState,
        rules: qualityState.rules.map((rule) =>
          rule.column_name === oldColumn ? { ...rule, column_name: newColumn } : rule,
        ),
        summary: qualityState.summary
          ? { ...qualityState.summary, column_name: newColumn }
          : qualityState.summary,
      };
      renderProfiling();
    }
    renameColumnInLocalState(oldColumn, newColumn);
    closeRenameColumn();
    await loadPage(currentOffset);
    setStatus("Coluna renomeada.");
  } catch (error) {
    setStatus(String(error));
  } finally {
    saveRenameColumnButton.disabled = false;
  }
}

async function saveRename() {
  const document = renameDocument();
  const name = renameDocumentNameEl?.value.trim() ?? "";

  if (!document || !renameDocumentNameEl || !saveRenameButton) {
    setStatus("Documento nao encontrado para renomear.");
    return;
  }

  if (!name) {
    setStatus("Digite um nome para o documento.");
    renameDocumentNameEl.focus();
    return;
  }

  saveRenameButton.disabled = true;
  setStatus("Renomeando documento...");

  try {
    const renamedDocument = await invoke<DocumentInfo>("rename_document", {
      documentId: document.id,
      name,
    });

    documents = documents.map((item) =>
      item.id === renamedDocument.id ? renamedDocument : item,
    );

    if (currentSummary?.document_id === renamedDocument.id) {
      currentSummary = {
        ...currentSummary,
        file_name: renamedDocument.file_name,
      };
    }

    renderDocuments();
    renderSqlContext();
    refreshSqlSources().catch((error) => setStatus(String(error)));
    renderSummary(currentSummary, currentPage);
    closeRename();
    setStatus("Documento renomeado.");
  } catch (error) {
    setStatus(String(error));
  } finally {
    saveRenameButton.disabled = false;
  }
}

function exportDocument() {
  return documents.find((document) => document.id === exportDocumentId) ?? null;
}

function openExport(documentId: string) {
  const document = documents.find((item) => item.id === documentId);

  if (!document || !exportModalEl || !exportFormatEl) {
    setStatus("Documento nao encontrado para exportar.");
    return;
  }

  exportDocumentId = documentId;
  exportFormatEl.value = "csv";
  setOpenDocumentMenu(null);
  exportModalEl.classList.remove("hidden");
  exportFormatEl.focus();
}

function closeExport() {
  if (exportInProgress) {
    return;
  }

  forceCloseExport();
}

function forceCloseExport() {
  exportDocumentId = null;
  exportModalEl?.classList.add("hidden");
  if (exportFormatEl) {
    exportFormatEl.value = "csv";
  }
}

async function runExport() {
  const document = exportDocument();
  const format = (
    exportFormatEl?.value === "xlsx"
      ? "xlsx"
      : exportFormatEl?.value === "tsv"
        ? "tsv"
        : "csv"
  ) satisfies ExportFormat;

  if (!document || !runExportButton) {
    setStatus("Documento nao encontrado para exportar.");
    return;
  }

  if (!isTauri()) {
    setStatus("Exportacao disponivel apenas no app Tauri. Rode npm run tauri:dev.");
    return;
  }

  const extension = exportExtension(format);
  const selected = await save({
    defaultPath: `${sanitizeFileName(document.file_name)}.${extension}`,
    filters: [
      {
        name: exportDelimiterName(format),
        extensions: [extension],
      },
    ],
  });

  if (!selected) {
    setStatus("Exportacao cancelada.");
    return;
  }

  exportInProgress = true;
  runExportButton.disabled = true;
  exportButtonLabelEl && (exportButtonLabelEl.textContent = "Exportando...");
  exportButtonSpinnerEl?.classList.remove("hidden");
  cancelExportXButton?.setAttribute("disabled", "true");
  exportFormatEl?.setAttribute("disabled", "true");
  exportProgressEl?.classList.remove("hidden");
  setStatus("Exportando documento...");
  showLoading("Exportando arquivo...");

  try {
    await invoke("export_document", {
      documentId: document.id,
      path: selected,
      format,
    });
    exportInProgress = false;
    closeExport();
    setStatus(`Documento exportado em ${exportDelimiterName(format)}.`);
  } catch (error) {
    setStatus(String(error));
  } finally {
    hideLoading();
    exportInProgress = false;
    runExportButton.disabled = false;
    exportButtonLabelEl && (exportButtonLabelEl.textContent = "Exportar");
    exportButtonSpinnerEl?.classList.add("hidden");
    cancelExportXButton?.removeAttribute("disabled");
    exportFormatEl?.removeAttribute("disabled");
    exportProgressEl?.classList.add("hidden");
  }
}

function closeDeleteModal(confirmed: boolean) {
  deleteModalEl?.classList.add("hidden");
  deleteDocumentId = null;

  if (resolveDeleteConfirmation) {
    resolveDeleteConfirmation(confirmed);
    resolveDeleteConfirmation = null;
  }
}

function confirmDeleteDocument(documentId: string) {
  const document = documents.find((item) => item.id === documentId);
  const label = document?.file_name ?? "este documento";
  deleteDocumentId = documentId;

  if (!deleteModalEl || !deleteMessageEl) {
    return Promise.resolve(false);
  }

  deleteMessageEl.textContent = `Tem certeza que deseja excluir "${label}"? Os dados importados desse documento serao removidos do DuckDB.`;
  deleteModalEl.classList.remove("hidden");
  confirmDeleteButton?.focus();

  return new Promise<boolean>((resolve) => {
    resolveDeleteConfirmation = resolve;
  });
}

function renderColumnsModal() {
  if (!columnsModalEl || !columnsListEl || !columnsSubtitleEl) {
    return;
  }

  if (!columnSettingsOpen || !currentPage || dataMode !== "document" || !currentDocumentId) {
    columnsModalEl.classList.add("hidden");
    columnsListEl.innerHTML = "";
    return;
  }

  const hiddenColumns = readHiddenColumns(currentDocumentId);
  const visibleCount = visibleColumnCount(currentPage);

  columnsSubtitleEl.textContent = `${formatNumber(visibleCount)} de ${formatNumber(
    currentPage.columns.length,
  )} colunas visiveis neste documento.`;
  columnsListEl.innerHTML = currentPage.columns
    .map(
      (column) => `
        <label class="column-option" title="${escapeHtml(column)}">
          <input
            type="checkbox"
            data-column-visibility="${escapeHtml(column)}"
            ${hiddenColumns.has(column) ? "" : "checked"}
          />
          <span>${escapeHtml(column)}</span>
        </label>
      `,
    )
    .join("");

  columnsModalEl.classList.remove("hidden");
}

function openColumnsModal() {
  if (!currentPage || dataMode !== "document" || !currentDocumentId) {
    setStatus("Selecione um documento para configurar as colunas.");
    return;
  }

  columnSettingsOpen = true;
  renderColumnsModal();
}

function closeColumnsModal() {
  columnSettingsOpen = false;
  renderColumnsModal();
}

async function setColumnVisible(column: string, visible: boolean) {
  if (!currentDocumentId || !currentPage) {
    return;
  }

  const hiddenColumns = readHiddenColumns(currentDocumentId);

  if (visible) {
    hiddenColumns.delete(column);
  } else {
    const currentlyVisibleCount = currentPage.columns.filter((item) => !hiddenColumns.has(item)).length;

    if (currentlyVisibleCount <= 1 && !hiddenColumns.has(column)) {
      setStatus("Mantenha pelo menos uma coluna visivel.");
      renderColumnsModal();
      return;
    }

    const hadActiveFilter = Boolean(filterValues.get(column));
    const hadActiveSort = sortColumn === column;
    hiddenColumns.add(column);
    filterValues.delete(column);

    if (hadActiveSort) {
      sortColumn = null;
      sortDirection = null;
    }

    writeHiddenColumns(currentDocumentId, hiddenColumns);

    if (hadActiveFilter || hadActiveSort) {
      await loadPage(0);
      return;
    }
  }

  writeHiddenColumns(currentDocumentId, hiddenColumns);

  await loadPage(0);
  renderColumnsModal();
}

async function showAllColumns() {
  if (!currentDocumentId || !currentPage) {
    return;
  }

  writeHiddenColumns(currentDocumentId, new Set());
  await loadPage(0);
  renderColumnsModal();
}

function captureFilterFocus(): FilterFocusState | null {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLInputElement)) {
    return null;
  }

  if (!activeElement.matches("[data-filter-column]")) {
    return null;
  }

  const column = activeElement.dataset.filterColumn;

  if (!column) {
    return null;
  }

  return {
    column,
    selectionStart: activeElement.selectionStart,
    selectionEnd: activeElement.selectionEnd,
  };
}

function restoreFilterFocus(focusState: FilterFocusState | null) {
  if (!focusState || !tableHeadEl) {
    return;
  }

  const input = Array.from(
    tableHeadEl.querySelectorAll<HTMLInputElement>("[data-filter-column]"),
  ).find((item) => item.dataset.filterColumn === focusState.column);

  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });

  if (focusState.selectionStart === null || focusState.selectionEnd === null) {
    return;
  }

  const valueLength = input.value.length;
  input.setSelectionRange(
    Math.min(focusState.selectionStart, valueLength),
    Math.min(focusState.selectionEnd, valueLength),
  );
}

function findCell(position: CellPosition) {
  if (!tableBodyEl) {
    return null;
  }

  return (
    Array.from(tableBodyEl.querySelectorAll<HTMLElement>("[data-cell-row][data-cell-column]"))
      .find(
        (cell) =>
          Number(cell.dataset.cellRow) === position.row &&
          Number(cell.dataset.cellColumn) === position.column,
      ) ?? null
  );
}

function focusCell(position: CellPosition) {
  const cell = findCell(position);

  if (!cell) {
    return false;
  }

  cell.focus({ preventScroll: true });
  cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function restorePendingCellFocus() {
  if (!pendingCellFocus || !currentPage || gridKnownTotalRows === 0) {
    pendingCellFocus = null;
    return;
  }

  const target = {
    row: Math.min(pendingCellFocus.row, gridKnownTotalRows - 1),
    column: Math.min(pendingCellFocus.column, visibleColumnCount(currentPage) - 1),
  };

  if (focusCell(target)) {
    pendingCellFocus = null;
  }
}

async function moveCellFocus(position: CellPosition, direction: "next-column" | "previous-column" | "next-row" | "previous-row") {
  const columnCount = visibleColumnCount();

  if (!currentPage || columnCount === 0 || gridKnownTotalRows === 0) {
    return;
  }

  let nextRow = position.row;
  let nextColumn = position.column;

  if (direction === "next-column") {
    nextColumn += 1;

    if (nextColumn >= columnCount) {
      nextColumn = 0;
      nextRow += 1;
    }
  }

  if (direction === "previous-column") {
    nextColumn -= 1;

    if (nextColumn < 0) {
      nextColumn = columnCount - 1;
      nextRow -= 1;
    }
  }

  if (direction === "next-row") {
    nextRow += 1;
  }

  if (direction === "previous-row") {
    nextRow -= 1;
  }

  if (nextRow < 0) {
    focusCell(position);
    return;
  }

  if (nextRow >= gridKnownTotalRows) {
    focusCell(position);
    return;
  }

  const target = {
    row: nextRow,
    column: nextColumn,
  };

  pendingCellFocus = target;

  if (tableViewportEl) {
    tableViewportEl.scrollTop = Math.max(0, nextRow * GRID_ROW_HEIGHT);
  }

  ensureVisibleRowsLoaded();
  window.setTimeout(() => restorePendingCellFocus(), 0);
}

function measureTextWidth(value: string) {
  if (!measureContext) {
    const canvas = document.createElement("canvas");
    measureContext = canvas.getContext("2d");
  }

  if (!measureContext) {
    return value.length * 8;
  }

  const font =
    tableBodyEl && window.getComputedStyle(tableBodyEl).font
      ? window.getComputedStyle(tableBodyEl).font
      : "14px system-ui";
  measureContext.font = font;
  return measureContext.measureText(value).width;
}

function autoFitColumnWidth(visibleIndex: number, columnName: string) {
  const sampleValues = [columnName];

  for (const rows of gridRowsCache.values()) {
    for (const row of rows) {
      if (sampleValues.length >= COLUMN_WIDTH_CONFIG.autoFitSampleSize + 1) {
        break;
      }

      sampleValues.push(cellDisplayValue(row[visibleIndex] ?? null));
    }
  }

  if (selectedCell?.columnName === columnName) {
    sampleValues.push(cellDisplayValue(selectedCell.value));
  }

  const widest = sampleValues.reduce(
    (width, value, index) =>
      Math.max(width, measureTextWidth(value) + (index === 0 ? COLUMN_WIDTH_CONFIG.headerPadding : COLUMN_WIDTH_CONFIG.cellPadding)),
    0,
  );

  return clampColumnWidth(widest, COLUMN_WIDTH_CONFIG.maxAutoFit);
}

function isCellTruncated(cell: HTMLElement) {
  return cell.scrollWidth > cell.clientWidth + 1;
}

function ensureCellPopover() {
  if (!cellPopoverEl) {
    cellPopoverEl = document.createElement("div");
    cellPopoverEl.className = "cell-full-popover hidden";
    cellPopoverEl.setAttribute("role", "tooltip");
    document.body.appendChild(cellPopoverEl);
  }

  return cellPopoverEl;
}

function positionCellPopover(cell: HTMLElement, popover: HTMLElement) {
  const rect = cell.getBoundingClientRect();
  const viewportPadding = 8;
  const maxWidth = Math.min(720, window.innerWidth - viewportPadding * 2);

  popover.style.maxWidth = `${maxWidth}px`;
  popover.style.left = `${Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - viewportPadding)}px`;
  popover.style.top = `${Math.min(window.innerHeight - viewportPadding, rect.bottom + 6)}px`;

  const popoverRect = popover.getBoundingClientRect();
  const overflowRight = popoverRect.right - window.innerWidth + viewportPadding;

  if (overflowRight > 0) {
    popover.style.left = `${Math.max(viewportPadding, rect.left - overflowRight)}px`;
  }

  if (popoverRect.bottom > window.innerHeight - viewportPadding) {
    popover.style.top = `${Math.max(viewportPadding, rect.top - popoverRect.height - 6)}px`;
  }
}

function showCellPopover(cell: HTMLElement, value: string, mode: "selection" | "hover") {
  if (!value || !isCellTruncated(cell)) {
    if (mode === "selection") {
      hideCellPopover();
    }
    return;
  }

  const popover = ensureCellPopover();
  activePopoverMode = mode;
  popover.textContent = value;
  popover.classList.toggle("selection", mode === "selection");
  popover.classList.remove("hidden");
  positionCellPopover(cell, popover);
}

function hideCellPopover(mode?: "selection" | "hover") {
  if (mode && activePopoverMode !== mode) {
    return;
  }

  cellPopoverEl?.classList.add("hidden");
  activePopoverMode = null;
}

function cellStateFromElement(cell: HTMLElement): SelectedCellState | null {
  const row = Number(cell.dataset.cellRow);
  const column = Number(cell.dataset.cellColumn);
  const rowId = cell.dataset.valtronRowId ?? "";
  const columnName = cell.dataset.cellColumnName ?? "";

  if (!Number.isInteger(row) || !Number.isInteger(column) || !rowId || !columnName) {
    return null;
  }

  const cachedValue = cachedRow(row)?.[column] ?? null;

  return {
    row,
    column,
    rowId,
    columnName,
    value: cachedValue,
  };
}

function selectCell(cell: HTMLElement, showFullValue = true) {
  const state = cellStateFromElement(cell);

  if (!state) {
    return;
  }

  selectedCell = state;
  tableBodyEl
    ?.querySelectorAll(".data-cell.selected")
    .forEach((item) => item.classList.remove("selected"));
  cell.classList.add("selected");

  if (showFullValue) {
    showCellPopover(cell, cellDisplayValue(state.value), "selection");
  }
}

function activeEditPosition(): CellPosition | null {
  return activeCellEdit ? { row: activeCellEdit.row, column: activeCellEdit.column } : null;
}

function focusActiveCellEditor() {
  if (!activeCellEdit || activeCellEdit.status !== "editing") {
    return;
  }

  const editor = tableBodyEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-cell-editor]");

  if (!editor || document.activeElement === editor) {
    return;
  }

  editor.focus({ preventScroll: true });
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

function startCellEdit(cell: HTMLElement) {
  if (dataMode !== "document") {
    setStatus("Edicao disponivel apenas em documentos importados.");
    return;
  }

  const state = cellStateFromElement(cell);

  if (!state) {
    setStatus("Celula sem ID interno para edicao.");
    return;
  }

  activeCellEdit = {
    ...state,
    originalValue: state.value,
    value: state.value,
    draft: cellDraftValue(state.value),
    operationId: ++cellEditSeq,
    status: "editing",
    error: null,
  };
  selectedCell = state;
  hideCellPopover();
  renderVirtualRows();
}

function cancelActiveCellEdit(render = true) {
  activeCellEdit = null;

  if (render) {
    renderVirtualRows();
    if (selectedCell) {
      window.setTimeout(() => focusCell(selectedCell as CellPosition), 0);
    }
  }
}

function updateActiveEditDraft(value: string) {
  if (!activeCellEdit || activeCellEdit.status !== "editing") {
    return;
  }

  activeCellEdit = {
    ...activeCellEdit,
    draft: value,
    value,
    error: null,
  };
}

async function commitActiveCellEdit(renderOnNoop = true) {
  if (!activeCellEdit || activeCellEdit.status === "saving") {
    return true;
  }

  if (!currentDocumentId) {
    activeCellEdit.error = "Documento nao encontrado.";
    renderVirtualRows();
    return false;
  }

  const edit = activeCellEdit;
  const newValue: CellValue = edit.draft;

  if (edit.originalValue === newValue) {
    activeCellEdit = null;
    if (renderOnNoop) renderVirtualRows();
    return true;
  }

  const operationId = ++cellEditSeq;
  const operationKey = cellCacheKey(edit.rowId, edit.columnName);
  pendingCellOperations.set(operationKey, operationId);
  activeCellEdit = {
    ...edit,
    value: newValue,
    operationId,
    status: "saving",
    error: null,
  };

  updateCachedCell(edit.row, edit.column, newValue);
  selectedCell = { ...edit, value: newValue };
  renderVirtualRows();

  try {
    await invoke("update_document_cell", {
      documentId: currentDocumentId,
      rowId: Number(edit.rowId),
      column: edit.columnName,
      value: newValue,
    });

    if (pendingCellOperations.get(operationKey) !== operationId) {
      return true;
    }

    pendingCellOperations.delete(operationKey);
    recentCellUpdates.set(operationKey, Date.now() + 1200);
    profilingCache.invalidate(currentDocumentId, edit.columnName);
    if (profilingState.documentId === currentDocumentId && profilingState.column === edit.columnName) {
      qualityState = {
        ...qualityState,
        status: qualityState.rules.length ? "loading" : "ready",
        summary: null,
        error: null,
      };
      loadQualityForColumn(currentDocumentId, edit.columnName, true).catch((error) => setStatus(String(error)));
    }
    activeCellEdit = null;
    if (filterValues.get(edit.columnName)?.operator === "quality_violation") {
      await loadPage(currentOffset);
    }
    renderVirtualRows();
    window.setTimeout(() => {
      if ((recentCellUpdates.get(operationKey) ?? 0) <= Date.now()) {
        recentCellUpdates.delete(operationKey);
        renderVirtualRows();
      }
    }, 1300);
    setStatus("Celula atualizada.");
    return true;
  } catch (error) {
    if (pendingCellOperations.get(operationKey) !== operationId) {
      return false;
    }

    pendingCellOperations.delete(operationKey);
    updateCachedCell(edit.row, edit.column, edit.originalValue);
    selectedCell = { ...edit, value: edit.originalValue };
    activeCellEdit = {
      ...edit,
      status: "editing",
      error: String(error),
    };
    renderVirtualRows();
    setStatus(String(error));
    return false;
  }
}

async function resolveActiveCellEditBeforeGridChange() {
  if (!activeCellEdit) {
    return true;
  }

  if (activeCellEdit.status === "saving") {
    return false;
  }

  return commitActiveCellEdit(false);
}

function repositionSelectedCellPopover() {
  if (!selectedCell || activePopoverMode !== "selection") {
    return;
  }

  const cell = findCell(selectedCell);

  if (!cell) {
    hideCellPopover("selection");
    return;
  }

  showCellPopover(cell, cellDisplayValue(selectedCell.value), "selection");
}

function renderSummary(summary: ImportSummary | null, page: TablePage | null = currentPage) {
  const document = selectedDocument();

  if (fileNameEl) fileNameEl.textContent = dataMode === "sql" ? "Resultado SQL" : summary?.file_name ?? document?.file_name ?? "-";
  if (sheetNameEl) sheetNameEl.textContent = dataMode === "sql" ? "Consulta personalizada" : summary?.sheet_name ?? document?.sheet_name ?? "-";
  if (rowCountEl) {
    rowCountEl.textContent = formatNumber(page?.total_rows ?? summary?.row_count ?? document?.row_count ?? 0);
  }
  if (columnCountEl) {
    columnCountEl.textContent = formatNumber(
      page?.stats.column_count ?? summary?.columns.length ?? document?.column_count ?? 0,
    );
  }
  if (emptyColumnCountEl) {
    emptyColumnCountEl.textContent = formatNumber(page?.stats.columns_with_empty ?? 0);
  }
  if (emptyCellCountEl) {
    emptyCellCountEl.textContent = formatNumber(page?.stats.empty_cells ?? 0);
  }
  if (filterCountEl) {
    filterCountEl.textContent = formatNumber(activeFilters().length);
  }
}

function renderDocuments() {
  if (!documentsSubtitleEl || !documentsListEl) {
    return;
  }

  documentsSubtitleEl.textContent =
    documents.length === 0
      ? "Nenhum documento importado."
      : `${formatNumber(documents.length)} documento(s) disponiveis.`;

  if (documents.length === 0) {
    documentsListEl.innerHTML = `
      <div class="documents-empty sidebar-label">
        <strong>Nenhum documento neste workspace</strong>
        <span>Use "Importar XLSX ou CSV" para adicionar um arquivo.</span>
      </div>
    `;
    return;
  }

  documentsListEl.innerHTML = documents
    .map(
      (document) => `
        <article class="document-item ${document.id === currentDocumentId ? "active" : ""}">
          <button
            class="document-select"
            type="button"
            data-document-id="${escapeHtml(document.id)}"
            title="${escapeHtml(document.file_name)}"
            ${document.id === currentDocumentId ? 'aria-current="page"' : ""}
          >
            <span class="document-icon" aria-hidden="true" title="${escapeHtml(document.file_name)}">${escapeHtml(document.file_name.slice(0, 1).toUpperCase() || "D")}</span>
            <span class="document-copy">
              <strong>${escapeHtml(document.file_name)}</strong>
              <span>${escapeHtml(document.sheet_name)} · ${formatNumber(document.row_count)} linhas · ${formatNumber(
                document.column_count,
              )} colunas</span>
              <small>${escapeHtml(document.table_name)} · ${formatImportedAt(document.imported_at)}</small>
            </span>
            <span class="document-tooltip" role="tooltip">${escapeHtml(document.file_name)}</span>
          </button>
          <div class="document-menu-wrap sidebar-label">
            <button
              class="document-menu-trigger"
              type="button"
              data-menu-document-id="${escapeHtml(document.id)}"
              aria-label="Opcoes do documento"
              aria-expanded="${openDocumentMenuId === document.id ? "true" : "false"}"
            >⋯</button>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderQuality(stats: TableStats | null) {
  if (!qualitySubtitleEl || !qualityListEl) {
    return;
  }

  if (!stats) {
    qualitySubtitleEl.textContent = "Importe um arquivo para calcular.";
    qualityListEl.innerHTML = "";
    return;
  }

  if (stats.quality.length === 0) {
    qualitySubtitleEl.textContent = "Nenhuma coluna com valores nulos ou vazios.";
    qualityListEl.innerHTML = `<span class="quality-pill success">Sem vazios detectados</span>`;
    return;
  }

  qualitySubtitleEl.textContent = `${formatNumber(stats.columns_with_empty)} de ${formatNumber(
    stats.column_count,
  )} colunas tem pelo menos um campo vazio.`;
  qualityListEl.innerHTML = stats.quality
    .slice()
    .sort((a, b) => b.empty_count - a.empty_count)
    .map(
      (item) => `
        <span class="quality-pill" title="${escapeHtml(item.column)}">
          ${escapeHtml(item.column)}
          <strong>${formatNumber(item.empty_count)}</strong>
        </span>
      `,
    )
    .join("");
}

function selectedWorkspace() {
  return workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? null;
}

function renderWorkspaces() {
  if (!workspaceSubtitleEl || !workspaceSelectEl) {
    return;
  }

  workspaceSubtitleEl.textContent =
    workspaces.length === 0
      ? "Nenhum workspace encontrado."
      : `${formatNumber(workspaces.length)} workspace(s), ${formatNumber(
          selectedWorkspace()?.document_count ?? 0,
        )} documento(s) no atual.`;

  workspaceSelectEl.innerHTML = workspaces
    .map(
      (workspace) => `
        <option value="${escapeHtml(workspace.id)}" ${workspace.id === currentWorkspaceId ? "selected" : ""}>
          ${escapeHtml(workspace.name)} (${formatNumber(workspace.document_count)})
        </option>
      `,
    )
    .join("");
  renderSqlContext();
}

function renderProfiling() {
  if (!profilingRootEl) {
    return;
  }

  renderProfilingDrawer(profilingRootEl, profilingState, qualityState, transformationState, {
    onClose: closeProfilingDrawer,
    onRetry: (column) => {
      openColumnProfile(column).catch((error) => setStatus(String(error)));
    },
    onFilterValue: (column, value) => {
      applyProfileValueFilter(column, value).catch((error) => setStatus(String(error)));
    },
    onFilterEmpty: (column) => {
      applyProfileEmptyFilter(column).catch((error) => setStatus(String(error)));
    },
    activeFilterLabel,
    onTabChange: (tab) => {
      profilingState = {
        ...profilingState,
        activeTab: tab,
      };
      renderProfiling();
      if (tab === "quality" && profilingState.documentId && profilingState.column) {
        loadQualityForColumn(profilingState.documentId, profilingState.column).catch((error) =>
          setStatus(String(error)),
        );
      }
    },
    quality: {
      onAddRule: () => {
        qualityState = { ...qualityState, mode: "form", editingRule: null };
        renderProfiling();
      },
      onCancelForm: () => {
        qualityState = { ...qualityState, mode: "list", editingRule: null };
        renderProfiling();
      },
      onSaveRule: (input, ruleId) => {
        saveQualityRule(input, ruleId).catch((error) => setStatus(String(error)));
      },
      onEditRule: (rule) => {
        qualityState = { ...qualityState, mode: "form", editingRule: rule };
        renderProfiling();
      },
      onToggleRule: (rule) => {
        toggleQualityRule(rule).catch((error) => setStatus(String(error)));
      },
      onDeleteRule: (rule) => {
        removeQualityRule(rule).catch((error) => setStatus(String(error)));
      },
      onApplyRuleFilter: (rule) => {
        applyQualityRuleFilter(rule).catch((error) => setStatus(String(error)));
      },
      onRetryQuality: () => {
        if (profilingState.documentId && profilingState.column) {
          loadQualityForColumn(profilingState.documentId, profilingState.column, true).catch((error) =>
            setStatus(String(error)),
          );
        }
      },
    },
    transformation: {
      onSelectType: (type) => {
        transformationState = {
          ...createTransformationState(),
          selectedType: type,
          configuration: defaultTransformationConfig(type),
        };
        renderProfiling();
      },
      onConfigChange: (key, value) => {
        transformationState = {
          ...transformationState,
          configuration: {
            ...transformationState.configuration,
            [key]: value,
          },
          status: "idle",
          preview: null,
          applied: null,
          error: null,
        };
        renderProfilingPreservingTransformField(key);
      },
      onPreview: () => {
        previewCurrentTransformation().catch((error) => setStatus(String(error)));
      },
      onApply: () => {
        applyCurrentTransformation().catch((error) => setStatus(String(error)));
      },
    },
  });
}

function renderProfilingPreservingTransformField(fieldKey: string) {
  if (!profilingRootEl) {
    return;
  }

  const drawer = profilingRootEl.querySelector<HTMLElement>(".profile-drawer");
  const active = document.activeElement;
  const activeConfig =
    active instanceof HTMLInputElement || active instanceof HTMLSelectElement
      ? active.dataset.transformConfig
      : null;
  const selection =
    active instanceof HTMLInputElement
      ? {
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  const scrollTop = drawer?.scrollTop ?? 0;
  const restoreKey = activeConfig ?? fieldKey;

  renderProfiling();

  const nextDrawer = profilingRootEl.querySelector<HTMLElement>(".profile-drawer");
  if (nextDrawer) {
    nextDrawer.scrollTop = scrollTop;
  }

  const nextField = profilingRootEl.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-transform-config="${CSS.escape(restoreKey)}"]`,
  );

  if (!nextField) {
    return;
  }

  nextField.focus({ preventScroll: true });
  if (selection && nextField instanceof HTMLInputElement && nextField.type !== "checkbox") {
    const length = nextField.value.length;
    nextField.setSelectionRange(
      Math.min(selection.start ?? length, length),
      Math.min(selection.end ?? length, length),
    );
  }

  if (nextDrawer) {
    nextDrawer.scrollTop = scrollTop;
  }
}

function closeProfilingDrawer() {
  profilingState = createProfilingState();
  qualityState = createQualityState();
  transformationState = createTransformationState();
  profilingRequestSeq += 1;
  renderProfiling();
}

function currentTransformationPayload() {
  if (!profilingState.column || !transformationState.selectedType) {
    return null;
  }

  return {
    type: transformationState.selectedType,
    column: profilingState.column,
    configuration: transformationState.configuration,
  };
}

async function previewCurrentTransformation() {
  if (!currentDocumentId) {
    setStatus("Selecione um documento para transformar.");
    return;
  }

  const transformation = currentTransformationPayload();
  if (!transformation) {
    setStatus("Selecione uma transformacao.");
    return;
  }

  transformationState = {
    ...transformationState,
    status: "previewing",
    preview: null,
    applied: null,
    error: null,
  };
  renderProfiling();
  setStatus("Calculando preview da transformacao...");

  try {
    const preview = await previewTransformation(currentDocumentId, transformation);
    transformationState = {
      ...transformationState,
      status: "ready",
      preview,
      error: null,
    };
    renderProfiling();
    setStatus(`${formatNumber(preview.affected_rows)} registros serao alterados.`);
  } catch (error) {
    transformationState = {
      ...transformationState,
      status: "error",
      error: String(error),
    };
    renderProfiling();
    setStatus(String(error));
  }
}

async function applyCurrentTransformation() {
  if (!currentDocumentId) {
    setStatus("Selecione um documento para transformar.");
    return;
  }

  const transformation = currentTransformationPayload();
  if (!transformation || !transformationState.preview) {
    setStatus("Gere o preview antes de aplicar.");
    return;
  }

  const confirmed = window.confirm(
    `Aplicar transformacao em ${formatNumber(transformationState.preview.affected_rows)} registros?`,
  );
  if (!confirmed) return;

  transformationState = {
    ...transformationState,
    status: "applying",
    error: null,
  };
  renderProfiling();
  setStatus("Aplicando transformacao...");

  try {
    const applied = await applyTransformation(currentDocumentId, transformation);
    profilingCache.invalidate(currentDocumentId, transformation.column);
    qualityState = {
      ...qualityState,
      status: qualityState.rules.length ? "idle" : qualityState.status,
      summary: null,
      error: null,
    };
    transformationState = {
      ...transformationState,
      status: "applied",
      applied,
      error: null,
    };
    resetGridCache();
    await loadPage(0);
    renderProfiling();
    setStatus(
      `Transformacao aplicada: ${formatNumber(applied.affected_rows)} alterados, ${formatNumber(applied.failed_rows)} invalidos.`,
    );
  } catch (error) {
    transformationState = {
      ...transformationState,
      status: "error",
      error: String(error),
    };
    renderProfiling();
    setStatus(String(error));
  }
}

async function loadQualityForColumn(documentId: string, column: string, force = false) {
  if (!force && qualityState.status === "ready" && profilingState.documentId === documentId && profilingState.column === column) {
    return;
  }

  qualityState = {
    ...qualityState,
    status: "loading",
    error: null,
  };
  renderProfiling();

  try {
    const rules = await listQualityRules(documentId, column);
    const summary = rules.length ? await validateQualityRules(documentId, column) : null;
    const activeRuleId = filterValues.get(column)?.operator === "quality_violation"
      ? filterValues.get(column)?.rule_id ?? null
      : null;
    qualityState = {
      ...qualityState,
      status: "ready",
      mode: "list",
      rules,
      summary,
      error: null,
      appliedRuleId: activeRuleId,
    };
    renderProfiling();
    renderTable(currentPage);
  } catch (error) {
    qualityState = {
      ...qualityState,
      status: "error",
      error: String(error),
    };
    renderProfiling();
  }
}

async function openColumnProfile(column: string) {
  if (dataMode !== "document" || !currentDocumentId) {
    setStatus("Profiling disponivel apenas para documentos importados.");
    return;
  }

  const documentId = currentDocumentId;
  const requestSeq = ++profilingRequestSeq;
  const cached = profilingCache.get(documentId, column);

  profilingState = cached
    ? {
        status: "ready",
        activeTab: profilingState.activeTab,
        documentId,
        column,
        profile: cached,
        error: null,
      }
    : {
        status: "loading",
        activeTab: profilingState.activeTab,
        documentId,
        column,
        profile: null,
        error: null,
  };
  qualityState = createQualityState();
  transformationState = createTransformationState();
  setOpenColumnMenu(null);
  renderProfiling();

  if (cached) {
    if (profilingState.activeTab === "quality") {
      loadQualityForColumn(documentId, column).catch((error) => setStatus(String(error)));
    }
    setStatus("Profiling carregado do cache da sessao.");
    return;
  }

  try {
    const profile = await getColumnProfile(documentId, column);

    if (requestSeq !== profilingRequestSeq || profilingState.documentId !== documentId || profilingState.column !== column) {
      return;
    }

    profilingCache.set(documentId, column, profile);
    profilingState = {
      status: "ready",
      activeTab: profilingState.activeTab,
      documentId,
      column,
      profile,
      error: null,
    };
    renderProfiling();
    renderTable(currentPage);
    if (profilingState.activeTab === "quality") {
      loadQualityForColumn(documentId, column).catch((error) => setStatus(String(error)));
    }
    setStatus(profile.performance.cache_hit ? "Profiling carregado do cache." : "Profiling concluido.");
  } catch (error) {
    if (requestSeq !== profilingRequestSeq) {
      return;
    }

    profilingState = {
      status: "error",
      activeTab: profilingState.activeTab,
      documentId,
      column,
      profile: null,
      error: String(error),
    };
    renderProfiling();
  }
}

async function applyProfileValueFilter(column: string, value: string) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  setEqualsFilter(column, value);
  renderProfiling();
  await loadPage(0);
  setStatus(`Filtro aplicado em ${column}.`);
}

async function applyProfileEmptyFilter(column: string) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  setEmptyFilter(column);
  renderProfiling();
  await loadPage(0);
  setStatus(`Filtro de vazios aplicado em ${column}.`);
}

async function saveQualityRule(input: QualityRuleInput, ruleId: string | null) {
  if (!currentDocumentId || !profilingState.column) {
    setStatus("Selecione uma coluna para configurar qualidade.");
    return;
  }

  if (!input.name) {
    setStatus("Digite um nome para a regra.");
    return;
  }

  setStatus(ruleId ? "Atualizando regra..." : "Salvando regra...");
  if (ruleId) {
    await updateQualityRule(ruleId, input);
  } else {
    await createQualityRule(currentDocumentId, input);
  }

  qualityState = {
    ...qualityState,
    mode: "list",
    editingRule: null,
    status: "loading",
    summary: null,
  };
  renderProfiling();
  await loadQualityForColumn(currentDocumentId, profilingState.column, true);
  renderTable(currentPage);
  setStatus("Regra de qualidade salva.");
}

async function toggleQualityRule(rule: QualityRule) {
  const nextEnabled = !rule.enabled;
  const input: QualityRuleInput = {
    column_name: rule.column_name,
    rule_type: rule.rule_type,
    name: rule.name,
    configuration_json: rule.configuration_json,
    enabled: nextEnabled,
  };
  await updateQualityRule(rule.id, input);
  if (!nextEnabled && filterValues.get(rule.column_name)?.rule_id === rule.id) {
    filterValues.delete(rule.column_name);
    qualityState = { ...qualityState, appliedRuleId: null };
    await loadPage(0);
  }
  if (currentDocumentId && profilingState.column) {
    await loadQualityForColumn(currentDocumentId, profilingState.column, true);
  }
  setStatus(input.enabled ? "Regra ativada." : "Regra desativada.");
}

async function removeQualityRule(rule: QualityRule) {
  const confirmed = window.confirm(`Excluir regra "${rule.name}"?`);
  if (!confirmed) return;

  await deleteQualityRule(rule.id);
  if (filterValues.get(rule.column_name)?.rule_id === rule.id) {
    filterValues.delete(rule.column_name);
    qualityState = { ...qualityState, appliedRuleId: null };
    await loadPage(0);
  }
  if (currentDocumentId && profilingState.column) {
    await loadQualityForColumn(currentDocumentId, profilingState.column, true);
  }
  setStatus("Regra excluida.");
}

async function applyQualityRuleFilter(rule: QualityRule) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  setQualityRuleFilter(rule);
  qualityState = { ...qualityState, appliedRuleId: rule.id };
  renderProfiling();
  await loadPage(0);
  setStatus(`Filtro de violacoes aplicado em ${rule.column_name}.`);
}

function renderTable(page: TablePage | null) {
  if (!tableHeadEl || !tableBodyEl || !tableSubtitleEl || !pageRangeEl) {
    return;
  }

  const filterFocus = captureFilterFocus();

  if (!page || page.columns.length === 0) {
    tableHeadEl.innerHTML = "";
    tableBodyEl.innerHTML = `
      <div class="empty-cell">Importe um arquivo para visualizar os dados.</div>
    `;
    tableSubtitleEl.textContent = "Aguardando importacao.";
    pageRangeEl.textContent = "-";
    tableHeadEl.style.minWidth = "";
    tableBodyEl.style.height = "";
    tableBodyEl.style.minWidth = "";
    if (openColumnsButton) openColumnsButton.disabled = true;
    if (clearFiltersButton) clearFiltersButton.disabled = true;
    setGridLoading(false);
    renderQuality(null);
    renderColumnsModal();
    return;
  }

  gridKnownTotalRows = page.total_rows;
  const visibleColumns = visibleColumnEntries(page);
  const gridTemplateColumns = gridColumnTemplate(visibleColumns.length);
  applyGridColumnWidths(visibleColumns);

  tableHeadEl.innerHTML = `
    <div class="grid-header-row" style="grid-template-columns: ${gridTemplateColumns};">
      <div class="grid-header-cell row-number-header" aria-label="Numero da linha">
        <div class="column-header row-number-title">#</div>
      </div>
      ${visibleColumns
        .map(
          ({ column, index }, visibleIndex) => {
            const profiled = currentDocumentId ? profilingCache.get(currentDocumentId, column) : null;
            const hint = qualityHeaderHint(column) || (profiled ? profileHeaderHint(profiled) : "");

            return `
            <div class="grid-header-cell" data-header-visible-column="${visibleIndex}" data-header-column="${escapeHtml(column)}">
              <div class="column-header">
                <button class="column-sort" type="button" data-sort-column="${escapeHtml(column)}" title="${escapeHtml(column)}">
                  <span class="column-title-text">${escapeHtml(column)}</span>
                  ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
                  <strong>${sortIndicator(column)}</strong>
                </button>
                ${
                  dataMode === "document"
                    ? `<button
                        class="column-menu-trigger"
                        type="button"
                        data-column-menu-trigger="${escapeHtml(column)}"
                        data-column-menu-index="${index}"
                        aria-label="Opcoes de ${escapeHtml(column)}"
                        aria-expanded="${openColumnMenu?.column === column ? "true" : "false"}"
                      >⋮</button>`
                    : ""
                }
              </div>
              <button
                class="column-resize-handle"
                type="button"
                data-resize-visible-column="${visibleIndex}"
                data-resize-column="${escapeHtml(column)}"
                aria-label="Redimensionar ${escapeHtml(column)}"
                title="Arraste para redimensionar. Duplo clique ajusta ao conteudo visivel."
              ></button>
            </div>
          `;
          },
        )
        .join("")}
    </div>
    <div class="grid-filter-row" style="grid-template-columns: ${gridTemplateColumns};">
      <div class="grid-header-cell row-number-header row-number-filter" aria-hidden="true"></div>
      ${visibleColumns
        .map(
          ({ column }) => `
            <div class="grid-header-cell">
              <input
                class="column-filter"
                data-filter-column="${escapeHtml(column)}"
                placeholder="Filtrar"
                value="${escapeHtml(filterValue(column))}"
              />
            </div>
          `,
        )
        .join("")}
    </div>
  `;

  tableSubtitleEl.textContent =
    dataMode === "sql"
      ? `${formatNumber(page.total_rows)} linhas no resultado SQL`
      : `${formatNumber(page.total_rows)} linhas na consulta atual`;

  if (clearFiltersButton) clearFiltersButton.disabled = activeFilters().length === 0 && !sortColumn;
  if (openColumnsButton) openColumnsButton.disabled = dataMode !== "document" || !currentDocumentId;

  renderQuality(page.stats);
  renderColumnsModal();
  renderVirtualRows();
  restoreFilterFocus(filterFocus);
  restorePendingCellFocus();
}

function gridColumnTemplate(visibleColumnCount: number) {
  const columns = Array.from({ length: Math.max(0, visibleColumnCount) }, (_item, index) => `var(--grid-col-${index}, ${COLUMN_WIDTH_CONFIG.default}px)`);
  return [`${GRID_ROW_NUMBER_WIDTH}px`, ...columns].join(" ");
}

function renderVirtualRows() {
  if (!tableBodyEl || !currentPage || !pageRangeEl) {
    return;
  }

  const visibleColumns = visibleColumnEntries(currentPage);
  const { start, end } = visibleRowBounds();
  const renderedRows: string[] = [];
  const gridTemplateColumns = gridColumnTemplate(visibleColumns.length);
  applyGridColumnWidths(visibleColumns);

  tableBodyEl.classList.add("virtual-body");
  tableBodyEl.style.height = `${Math.max(1, gridKnownTotalRows) * GRID_ROW_HEIGHT}px`;

  if (gridKnownTotalRows === 0) {
    tableBodyEl.innerHTML = `
      <div class="virtual-row empty-row" style="grid-template-columns: ${gridTemplateColumns}; top: 0; height: ${GRID_ROW_HEIGHT}px;">
        <div class="empty-cell">Nenhuma linha encontrada.</div>
      </div>
    `;
    pageRangeEl.textContent = "0";
    return;
  }

  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    const row = cachedRow(rowIndex);

    if (!row) {
      continue;
    }

    renderedRows.push(`
      <div class="virtual-row" style="grid-template-columns: ${gridTemplateColumns}; top: ${rowIndex * GRID_ROW_HEIGHT}px; height: ${GRID_ROW_HEIGHT}px;">
        <div class="row-number-cell" aria-label="Linha ${formatNumber(rowIndex + 1)}">${formatNumber(rowIndex + 1)}</div>
        ${visibleColumns
          .map(
            ({ column }, visibleIndex) => {
              const value = row[visibleIndex] ?? null;
              const rowId = rowIdForVisibleRow(rowIndex);
              const selected = selectedCell?.row === rowIndex && selectedCell.column === visibleIndex;
              const editing = Boolean(
                activeCellEdit &&
                  activeCellEdit.rowId === rowId &&
                  activeCellEdit.columnName === column,
              );
              const recentlyUpdated = rowId
                ? (recentCellUpdates.get(cellCacheKey(rowId, column)) ?? 0) > Date.now()
                : false;
              const displayValue = cellDisplayValue(value);
              const editable = dataMode === "document" && Boolean(rowId);
              const error = editing ? activeCellEdit?.error : null;
              const inputType = editorInputType(column);
              const editor =
                editing && activeCellEdit
                  ? inputType === "checkbox"
                    ? `<input class="cell-editor checkbox" data-cell-editor type="checkbox" ${/^(true|1|sim|yes)$/i.test(activeCellEdit.draft) ? "checked" : ""} ${activeCellEdit.status === "saving" ? "disabled" : ""} />`
                    : activeCellEdit.draft.length > 120 || columnWidth(column) >= 300
                    ? `<textarea class="cell-editor textarea" data-cell-editor spellcheck="false" ${activeCellEdit.status === "saving" ? "disabled" : ""}>${escapeHtml(activeCellEdit.draft)}</textarea>`
                    : `<input class="cell-editor" data-cell-editor type="${inputType}" value="${escapeHtml(activeCellEdit.draft)}" ${activeCellEdit.status === "saving" ? "disabled" : ""} />`
                  : "";

              return `
              <div
                class="data-cell ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${recentlyUpdated ? "recently-updated" : ""} ${value === null ? "is-null" : ""}"
                tabindex="0"
                data-cell-row="${rowIndex}"
                data-cell-column="${visibleIndex}"
                data-valtron-row-id="${escapeHtml(rowId)}"
                data-cell-column-name="${escapeHtml(column)}"
                aria-readonly="${editable ? "false" : "true"}"
              >${
                editing
                  ? `${editor}${error ? `<span class="cell-edit-error">${escapeHtml(error)}</span>` : ""}`
                  : escapeHtml(displayValue)
              }</div>
            `;
            },
          )
          .join("")}
      </div>
    `);
  }

  tableBodyEl.innerHTML = renderedRows.join("");
  focusActiveCellEditor();
  repositionSelectedCellPopover();
  pageRangeEl.textContent =
    end <= start ? "0" : `${formatNumber(start + 1)}-${formatNumber(Math.min(end, gridKnownTotalRows))}`;
}

function scheduleVirtualRender() {
  if (gridRenderFrame) {
    return;
  }

  gridRenderFrame = window.requestAnimationFrame(() => {
    gridRenderFrame = 0;
    renderVirtualRows();
    ensureVisibleRowsLoaded();
  });
}

async function loadWindow(offset: number, requestSeq: number, signature: string) {
  if (gridRowsCache.has(offset) || gridLoadingOffsets.has(offset)) {
    return;
  }

  gridLoadingOffsets.add(offset);
  setGridLoading(true);
  const frontendStart = performance.now();

  try {
    const visibleColumns = currentVisibleColumnNames();
    const page =
      dataMode === "sql"
        ? await invoke<TablePage>("get_sql_window", {
            query: currentSqlQuery,
            ...sqlContextPayload(),
            offset,
            limit: GRID_BATCH_SIZE,
            filters: activeFilters(),
            sortColumn,
            sortDirection,
            visibleColumns,
          })
        : await invoke<TablePage>("get_table_window", {
            documentId: currentDocumentId,
            offset,
            limit: GRID_BATCH_SIZE,
            filters: activeFilters(),
            sortColumn,
            sortDirection,
            visibleColumns,
          });

    if (requestSeq !== gridRequestSeq || signature !== gridSignature) {
      return;
    }

    currentPage = page;
    currentOffset = page.offset;
    sortColumn = page.sort_column;
    sortDirection = page.sort_direction;
    gridKnownTotalRows = page.total_rows;
    gridRowsCache.set(page.offset, page.rows);
    gridRowIdsCache.set(page.offset, page.row_ids ?? page.rows.map(() => null));
    pruneGridCache(page.offset);
    renderSummary(currentSummary, currentPage);
    renderTable(currentPage);
    setStatus("Dados carregados.");

    const frontendUpdate = Math.round(performance.now() - frontendStart);
    if (page.performance) {
      console.debug(
        `[GRID_PERFORMANCE]\nquery_duckdb: ${page.performance.query_duckdb_ms} ms\nrust_processing: ${page.performance.rust_processing_ms} ms\nipc_frontend_update: ${frontendUpdate} ms\ntotal_backend: ${page.performance.total_ms} ms\nrows: ${page.performance.rows}`,
      );
    }
  } finally {
    gridLoadingOffsets.delete(offset);
    setGridLoading(gridLoadingOffsets.size > 0);
  }
}

function ensureVisibleRowsLoaded() {
  if (!currentPage) {
    return;
  }

  const signature = gridSignature;
  const requestSeq = gridRequestSeq;
  const { start, end } = visibleRowBounds();
  const firstOffset = batchOffsetForRow(start);
  const lastOffset = batchOffsetForRow(Math.max(start, end - 1));

  for (let offset = firstOffset; offset <= lastOffset; offset += GRID_BATCH_SIZE) {
    loadWindow(offset, requestSeq, signature).catch((error) => setStatus(String(error)));
  }

  const loadedAheadOffset = batchOffsetForRow(Math.max(0, end - 1));
  const threshold = loadedAheadOffset + Math.floor(GRID_BATCH_SIZE * GRID_PREFETCH_RATIO);

  if (end >= threshold && loadedAheadOffset + GRID_BATCH_SIZE < gridKnownTotalRows) {
    loadWindow(loadedAheadOffset + GRID_BATCH_SIZE, requestSeq, signature).catch((error) =>
      setStatus(String(error)),
    );
  }
}

async function loadPage(offset: number) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  if (dataMode === "document" && !currentDocumentId) {
    renderSummary(null, null);
    renderTable(null);
    setStatus("Selecione ou importe um documento.");
    return;
  }

  if (dataMode === "sql" && !currentSqlQuery) {
    setStatus("Execute uma query SQL.");
    return;
  }

  setStatus("Carregando dados...");
  columnPreferences = readColumnPreferences();
  resetGridCache();
  gridSignature = gridStateSignature();
  await loadWindow(batchOffsetForRow(offset), gridRequestSeq, gridSignature);
}

function scheduleFilterReload() {
  if (filterTimer) {
    window.clearTimeout(filterTimer);
  }

  filterTimer = window.setTimeout(() => {
    loadPage(0).catch((error) => setStatus(String(error)));
  }, FILTER_DEBOUNCE_MS);
}

let pendingSheetSelection: ((sheetNames: string[] | null) => void) | null = null;

function isExcelPath(path: string) {
  return /\.(xlsx|xlsm)$/i.test(path);
}

function visibilityLabel(visibility: string) {
  if (visibility === "hidden") {
    return "Oculta";
  }

  if (visibility === "veryHidden") {
    return "Muito oculta";
  }

  return "";
}

function closeSheetModal(result: string[] | null) {
  sheetModalEl?.classList.add("hidden");
  const resolve = pendingSheetSelection;
  pendingSheetSelection = null;
  resolve?.(result);
}

function updateSheetConfirmButton() {
  if (!confirmSheetButton || !sheetListEl) {
    return;
  }

  const count = sheetListEl.querySelectorAll<HTMLInputElement>('input[name="excel-sheet"]:checked').length;
  confirmSheetButton.textContent = count === 1 ? "Importar 1 planilha" : `Importar ${formatNumber(count)} planilhas`;
  confirmSheetButton.disabled = count === 0;
}

function setWorkspaceDestinationError(message: string) {
  if (!workspaceDestinationErrorEl) {
    return;
  }

  workspaceDestinationErrorEl.textContent = message;
  workspaceDestinationErrorEl.classList.toggle("hidden", !message);
}

function closeWorkspaceDestinationModal(result: WorkspaceDestinationResult) {
  workspaceDestinationModalEl?.classList.add("hidden");
  workspaceDestinationImport = null;
  workspaceDestinationSearch = "";
  setWorkspaceDestinationError("");
  const resolve = pendingWorkspaceDestination;
  pendingWorkspaceDestination = null;
  resolve?.(result);
}

function closeImportSummaryModal(confirmed: boolean) {
  workspaceDestinationModalEl?.classList.add("hidden");
  workspaceDestinationImport = null;
  setWorkspaceDestinationError("");
  const resolve = pendingImportSummary;
  pendingImportSummary = null;
  resolve?.(confirmed);
}

function renderWorkspaceDestinationOptions(importInfo: PendingWorkspaceImport) {
  if (
    !workspaceDestinationContentEl ||
    !workspaceDestinationEyebrowEl ||
    !workspaceDestinationTitleEl ||
    !confirmWorkspaceDestinationButton
  ) {
    return;
  }

  const currentWorkspace = workspaceById(currentWorkspaceId);
  const suggestedWorkspaceName = fileNameWithoutExtension(importInfo.fileName);
  const existingWorkspaces = workspaces.filter((workspace) => workspace.id !== currentWorkspace?.id);
  const normalizedSearch = workspaceDestinationSearch.trim().toLocaleLowerCase("pt-BR");
  const filteredWorkspaces = normalizedSearch
    ? existingWorkspaces.filter((workspace) => workspace.name.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
    : existingWorkspaces;

  workspaceDestinationEyebrowEl.textContent = "Organizar documentos";
  workspaceDestinationTitleEl.textContent = "Destino da importacao";
  confirmWorkspaceDestinationButton.textContent = "Continuar";
  confirmWorkspaceDestinationButton.disabled = false;
  backWorkspaceDestinationButton?.classList.remove("hidden");

  if (!currentWorkspace && selectedWorkspaceDestinationMode === "current") {
    selectedWorkspaceDestinationMode = existingWorkspaces.length > 0 ? "existing" : "new";
  }

  if (selectedWorkspaceDestinationMode === "existing" && existingWorkspaces.length === 0) {
    selectedWorkspaceDestinationMode = currentWorkspace ? "current" : "new";
  }

  workspaceDestinationContentEl.innerHTML = `
    <div class="workspace-destination-intro">
      <p class="sheet-file-name">${escapeHtml(importInfo.fileName)}</p>
      <p class="toolbar-subtitle">Voce esta importando ${formatNumber(importInfo.sheetNames.length)} planilhas.</p>
    </div>
    <fieldset class="workspace-destination-options">
      ${
        currentWorkspace
          ? `
            <label class="workspace-destination-option">
              <input type="radio" name="workspace-destination-mode" value="current" ${
                selectedWorkspaceDestinationMode === "current" ? "checked" : ""
              } />
              <span>
                <strong>Workspace atual</strong>
                <small>${escapeHtml(currentWorkspace.name)}</small>
              </span>
            </label>
          `
          : ""
      }
      <label class="workspace-destination-option ${existingWorkspaces.length === 0 ? "disabled" : ""}">
        <input type="radio" name="workspace-destination-mode" value="existing" ${
          selectedWorkspaceDestinationMode === "existing" ? "checked" : ""
        } ${existingWorkspaces.length === 0 ? "disabled" : ""} />
        <span>
          <strong>Outro workspace</strong>
          <small>${existingWorkspaces.length === 0 ? "Nenhum outro workspace disponivel" : "Escolher existente"}</small>
        </span>
      </label>
      ${
        selectedWorkspaceDestinationMode === "existing" && existingWorkspaces.length > 0
          ? `
            <div class="workspace-picker">
              <input id="workspace-destination-search" class="workspace-destination-input" value="${escapeHtml(
                workspaceDestinationSearch,
              )}" placeholder="Buscar workspace..." autocomplete="off" />
              <div class="workspace-picker-list">
                ${
                  filteredWorkspaces.length
                    ? filteredWorkspaces
                        .map(
                          (workspace) => `
                            <label class="workspace-picker-item">
                              <input type="radio" name="workspace-destination-existing" value="${escapeHtml(workspace.id)}" ${
                                workspace.id === workspaceDestinationFormEl?.dataset.workspaceId ? "checked" : ""
                              } />
                              <span>
                                <strong>${escapeHtml(workspace.name)}</strong>
                                <small>${formatNumber(workspace.document_count)} documento(s)</small>
                              </span>
                            </label>
                          `,
                        )
                        .join("")
                    : `<p class="workspace-picker-empty">Nenhum workspace encontrado.</p>`
                }
              </div>
            </div>
          `
          : ""
      }
      <label class="workspace-destination-option">
        <input type="radio" name="workspace-destination-mode" value="new" ${
          selectedWorkspaceDestinationMode === "new" ? "checked" : ""
        } />
        <span>
          <strong>Criar novo workspace</strong>
          <small>O workspace sera criado somente ao importar.</small>
        </span>
      </label>
      ${
        selectedWorkspaceDestinationMode === "new"
          ? `
            <div class="workspace-new-name">
              <label for="workspace-destination-name">Nome do workspace</label>
              <input id="workspace-destination-name" class="workspace-destination-input" value="${escapeHtml(
                workspaceDestinationFormEl?.dataset.workspaceName || suggestedWorkspaceName,
              )}" autocomplete="off" />
            </div>
          `
          : ""
      }
    </fieldset>
  `;

  workspaceDestinationContentEl
    .querySelector<HTMLInputElement>('input[name="workspace-destination-mode"]:checked')
    ?.focus();
}

function selectedWorkspaceDestinationDraft(): WorkspaceDestinationDraft | null {
  const mode =
    workspaceDestinationContentEl?.querySelector<HTMLInputElement>('input[name="workspace-destination-mode"]:checked')
      ?.value ?? selectedWorkspaceDestinationMode;

  if (mode === "current") {
    const workspace = workspaceById(currentWorkspaceId);
    if (!workspace) {
      setWorkspaceDestinationError("Selecione um workspace atual ou escolha outro destino.");
      return null;
    }
    return { mode: "current", workspaceId: workspace.id, workspaceName: workspace.name };
  }

  if (mode === "existing") {
    const workspaceId =
      workspaceDestinationContentEl?.querySelector<HTMLInputElement>('input[name="workspace-destination-existing"]:checked')
        ?.value ?? null;
    const workspace = workspaceById(workspaceId);
    if (!workspace) {
      setWorkspaceDestinationError("Escolha um workspace existente.");
      return null;
    }
    return { mode: "existing", workspaceId: workspace.id, workspaceName: workspace.name };
  }

  const name = workspaceDestinationContentEl?.querySelector<HTMLInputElement>("#workspace-destination-name")?.value.trim() ?? "";
  if (!name) {
    setWorkspaceDestinationError("Digite um nome para o workspace.");
    workspaceDestinationContentEl?.querySelector<HTMLInputElement>("#workspace-destination-name")?.focus();
    return null;
  }

  return { mode: "new", workspaceId: null, workspaceName: name };
}

function chooseWorkspaceDestination(importInfo: PendingWorkspaceImport): Promise<WorkspaceDestinationResult> {
  if (!workspaceDestinationModalEl || !workspaceDestinationFormEl || !workspaceDestinationContentEl) {
    return Promise.resolve({
      mode: "current",
      workspaceId: currentWorkspaceId,
      workspaceName: selectedWorkspace()?.name ?? "Workspace atual",
    });
  }

  workspaceDestinationImport = importInfo;
  selectedWorkspaceDestinationMode = currentWorkspaceId ? "current" : workspaces.length > 0 ? "existing" : "new";
  workspaceDestinationFormEl.dataset.workspaceId = workspaces.find((workspace) => workspace.id !== currentWorkspaceId)?.id ?? "";
  workspaceDestinationFormEl.dataset.workspaceName = fileNameWithoutExtension(importInfo.fileName);
  workspaceDestinationSearch = "";
  setWorkspaceDestinationError("");
  renderWorkspaceDestinationOptions(importInfo);
  workspaceDestinationModalEl.classList.remove("hidden");

  return new Promise((resolve) => {
    pendingWorkspaceDestination = resolve;
  });
}

function renderImportSummary(importInfo: PendingWorkspaceImport, destination: WorkspaceDestinationDraft) {
  if (
    !workspaceDestinationContentEl ||
    !workspaceDestinationEyebrowEl ||
    !workspaceDestinationTitleEl ||
    !confirmWorkspaceDestinationButton
  ) {
    return;
  }

  workspaceDestinationEyebrowEl.textContent = "Resumo";
  workspaceDestinationTitleEl.textContent = `Importar ${formatNumber(importInfo.sheetNames.length)} planilhas`;
  confirmWorkspaceDestinationButton.textContent = `Importar ${formatNumber(importInfo.sheetNames.length)} planilhas`;
  confirmWorkspaceDestinationButton.disabled = false;
  backWorkspaceDestinationButton?.classList.remove("hidden");
  workspaceDestinationContentEl.innerHTML = `
    <div class="import-summary">
      <dl>
        <div>
          <dt>Arquivo</dt>
          <dd>${escapeHtml(importInfo.fileName)}</dd>
        </div>
        <div>
          <dt>Destino</dt>
          <dd>${escapeHtml(destination.workspaceName)}</dd>
        </div>
      </dl>
      <div>
        <p class="toolbar-title">Documentos</p>
        <ul class="import-summary-sheets">
          ${importInfo.sheetNames.map((sheetName) => `<li>${escapeHtml(sheetName)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;
}

function confirmImportSummary(importInfo: PendingWorkspaceImport, destination: WorkspaceDestinationDraft): Promise<boolean> {
  if (!workspaceDestinationModalEl || !workspaceDestinationFormEl || !workspaceDestinationContentEl) {
    return Promise.resolve(true);
  }

  workspaceDestinationImport = importInfo;
  setWorkspaceDestinationError("");
  renderImportSummary(importInfo, destination);
  workspaceDestinationModalEl.classList.remove("hidden");

  return new Promise((resolve) => {
    pendingImportSummary = resolve;
  });
}

function chooseExcelSheets(inspection: ExcelWorkbookInspection): Promise<string[] | null> {
  if (!sheetModalEl || !sheetFormEl || !sheetListEl || !sheetFileNameEl || !sheetSubtitleEl) {
    return Promise.resolve(inspection.sheets[0] ? [inspection.sheets[0].name] : null);
  }

  sheetFileNameEl.textContent = inspection.file_name;
  sheetSubtitleEl.textContent = `${formatNumber(inspection.sheets.length)} planilhas encontradas.`;
  sheetListEl.innerHTML = inspection.sheets
    .map((sheet) => {
      const visibility = visibilityLabel(sheet.visibility);
      return `
        <label class="sheet-option">
          <input type="checkbox" name="excel-sheet" value="${escapeHtml(sheet.name)}" checked />
          <span class="sheet-option-copy">
            <strong>${escapeHtml(sheet.name)}</strong>
            ${visibility ? `<small>${escapeHtml(visibility)}</small>` : ""}
          </span>
        </label>
      `;
    })
    .join("");
  sheetModalEl.classList.remove("hidden");
  sheetListEl.querySelector<HTMLInputElement>('input[name="excel-sheet"]')?.focus();
  updateSheetConfirmButton();

  return new Promise((resolve) => {
    pendingSheetSelection = resolve;
  });
}

async function resolveExcelSheetForImport(path: string) {
  if (!isExcelPath(path)) {
    return { sheetNames: [null], workbookInspectionMs: null, inspection: null };
  }

  setStatus("Lendo estrutura do arquivo...");
  const inspection = await invoke<ExcelWorkbookInspection>("inspect_excel_workbook", { path });

  if (inspection.sheets.length === 0) {
    throw new Error("O arquivo nao possui planilhas.");
  }

  if (inspection.sheets.length === 1) {
    return {
      sheetNames: [inspection.sheets[0].name],
      workbookInspectionMs: inspection.inspection_duration_ms,
      inspection,
    };
  }

  const sheetNames = await chooseExcelSheets(inspection);

  if (!sheetNames || sheetNames.length === 0) {
    return null;
  }

  return {
    sheetNames,
    workbookInspectionMs: inspection.inspection_duration_ms,
    inspection,
  };
}

async function importFile(
  path: string,
  sheetName: string | null = null,
  workbookInspectionMs: number | null = null,
  workspaceId: string | null = currentWorkspaceId,
) {
  if (importButton) importButton.disabled = true;
  if (prevButton) prevButton.disabled = true;
  if (nextButton) nextButton.disabled = true;

  try {
    setStatus("Importando arquivo para o DuckDB...");
    showLoading("Carregando e importando arquivo...");
    dataMode = "document";
    currentSqlQuery = null;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
    currentSummary = await invoke<ImportSummary>("import_document", {
      path,
      workspaceId,
      sheetName,
      workbookInspectionMs,
    });
    currentDocumentId = currentSummary.document_id;
    currentWorkspaceId = workspaceId;
    await refreshWorkspaces();
    await refreshDocuments();
    renderSummary(currentSummary, null);
    await loadPage(0);
    setStatus("Importacao concluida.");
  } catch (error) {
    setStatus(formatImportErrorMessage(error));
    throw error;
  } finally {
    hideLoading();
    if (importButton) importButton.disabled = false;
  }
}

async function refreshWorkspaces() {
  workspaces = await invoke<WorkspaceInfo[]>("list_workspaces");

  if (!currentWorkspaceId && workspaces.length > 0) {
    currentWorkspaceId = workspaces[0].id;
  }

  if (currentWorkspaceId && !workspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    currentWorkspaceId = workspaces[0]?.id ?? null;
  }

  renderWorkspaces();
}

async function refreshDocuments() {
  if (!currentWorkspaceId) {
    documents = [];
    currentDocumentId = null;
    renderDocuments();
    return;
  }

  documents = await invoke<DocumentInfo[]>("list_documents", {
    workspaceId: currentWorkspaceId,
  });

  if (!currentDocumentId && documents.length > 0) {
    currentDocumentId = documents[0].id;
  }

  if (currentDocumentId && !documents.some((document) => document.id === currentDocumentId)) {
    currentDocumentId = documents[0]?.id ?? null;
  }

  renderDocuments();
  renderSqlContext();
  refreshSqlSources().catch((error) => setStatus(String(error)));
}

async function selectWorkspace(workspaceId: string) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  currentWorkspaceId = workspaceId;
  editingWorkspaceId = null;
  if (workspaceNameEl) workspaceNameEl.value = "";
  currentDocumentId = null;
  currentSummary = null;
  currentPage = null;
  currentOffset = 0;
  filterValues = new Map();
  sortColumn = null;
  sortDirection = null;
  pendingCellFocus = null;
  dataMode = "document";
  currentSqlQuery = null;
  closeProfilingDrawer();
  renderSummary(null, null);
  renderQuality(null);
  renderTable(null);
  renderWorkspaces();
  renderSqlContext();
  await refreshDocuments();

  if (currentDocumentId) {
    await loadPage(0);
  } else {
    setStatus("Workspace sem documentos. Importe um arquivo para comecar.");
  }
}

function loadSelectedWorkspaceForEdit() {
  const workspace = selectedWorkspace();

  if (!workspace || !workspaceNameEl) {
    setStatus("Selecione um workspace para editar.");
    return;
  }

  editingWorkspaceId = workspace.id;
  workspaceNameEl.value = workspace.name;
  workspaceNameEl.focus();
  workspaceNameEl.select();
  setStatus("Edite o nome e clique em salvar.");
}

async function createWorkspace() {
  if (!workspaceNameEl || !createWorkspaceButton) {
    return;
  }

  const name = workspaceNameEl.value.trim();

  if (!name) {
    setStatus("Digite um nome para o workspace.");
    workspaceNameEl.focus();
    return;
  }

  createWorkspaceButton.disabled = true;
  const isEditingWorkspace = Boolean(editingWorkspaceId);
  const workspaceIdBeingEdited = editingWorkspaceId;
  setStatus(isEditingWorkspace ? "Atualizando workspace..." : "Criando workspace...");

  try {
    const workspace = isEditingWorkspace
      ? await invoke<WorkspaceInfo>("update_workspace", {
          workspaceId: workspaceIdBeingEdited ?? "",
          name,
        })
      : await invoke<WorkspaceInfo>("create_workspace", { name });
    workspaceNameEl.value = "";
    editingWorkspaceId = null;
    currentWorkspaceId = workspace.id;
    await refreshWorkspaces();
    await selectWorkspace(workspace.id);
    setStatus(isEditingWorkspace ? "Workspace atualizado." : "Workspace criado.");
  } catch (error) {
    setStatus(String(error));
  } finally {
    createWorkspaceButton.disabled = false;
  }
}

async function selectDocument(documentId: string) {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  dataMode = "document";
  currentSqlQuery = null;
  currentDocumentId = documentId;
  currentSummary = null;
  currentPage = null;
  currentOffset = 0;
  filterValues = new Map();
  sortColumn = null;
  sortDirection = null;
  closeProfilingDrawer();
  renderDocuments();
  renderSqlContext();
  refreshSqlSources().catch((error) => setStatus(String(error)));
  await loadPage(0);
}

async function removeDocument(documentId: string) {
  if (!(await confirmDeleteDocument(documentId))) {
    return;
  }

  setStatus("Deletando documento...");
  await invoke("delete_document", { documentId });
  localStorage.removeItem(columnVisibilityStorageKey(documentId));
  profilingCache.invalidateDocument(documentId);

  if (currentDocumentId === documentId) {
    currentDocumentId = null;
    currentSummary = null;
    currentPage = null;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
    closeProfilingDrawer();
  }

  await refreshWorkspaces();
  await refreshDocuments();

  if (currentDocumentId) {
    await loadPage(0);
  } else {
    renderSummary(null, null);
    renderQuality(null);
    renderTable(null);
    setStatus("Documento deletado.");
  }
}

importButton?.addEventListener("click", async () => {
  if (!isTauri()) {
    setStatus("Importacao nativa disponivel apenas no app Tauri. Rode npm run tauri:dev.");
    return;
  }

  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Planilhas e CSV",
        extensions: ["xlsx", "xlsm", "csv"],
      },
    ],
  });

  if (typeof selected === "string") {
    try {
      let sheetSelection: ExcelSheetSelection | null = await resolveExcelSheetForImport(selected);

      if (!sheetSelection) {
        setStatus("Importacao cancelada.");
        return;
      }

      let destinationWorkspaceId = currentWorkspaceId;
      let destinationResolved = false;

      while (!destinationResolved) {
        destinationWorkspaceId = currentWorkspaceId;

        if (sheetSelection.sheetNames.length <= 1 || !sheetSelection.inspection) {
          destinationResolved = true;
          break;
        }

        await refreshWorkspaces();
        const selectedSheets = sheetSelection.sheetNames.filter((sheetName): sheetName is string => Boolean(sheetName));
        const importInfo = {
          path: selected,
          fileName: sheetSelection.inspection.file_name,
          sheetNames: selectedSheets,
        };
        let destination: WorkspaceDestinationDraft | null = null;

        while (!destination) {
          const draft = await chooseWorkspaceDestination(importInfo);

          if (draft === "back") {
            const revisedSheetNames = await chooseExcelSheets(sheetSelection.inspection);

            if (!revisedSheetNames || revisedSheetNames.length === 0) {
              setStatus("Importacao cancelada.");
              return;
            }

            sheetSelection = {
              ...sheetSelection,
              sheetNames: revisedSheetNames,
            };
            break;
          }

          if (!draft) {
            setStatus("Importacao cancelada.");
            return;
          }

          const confirmed = await confirmImportSummary(importInfo, draft);

          if (confirmed) {
            destination = draft;
          }
        }

        if (!destination) {
          continue;
        }

        if (destination.mode === "new") {
          setStatus("Criando workspace...");
          const workspace = await invoke<WorkspaceInfo>("create_workspace", { name: destination.workspaceName });
          destinationWorkspaceId = workspace.id;
          currentWorkspaceId = workspace.id;
          await refreshWorkspaces();
        } else {
          destinationWorkspaceId = destination.workspaceId;
          currentWorkspaceId = destination.workspaceId;
        }

        destinationResolved = true;
      }

      for (const [index, sheetName] of sheetSelection.sheetNames.entries()) {
        const total = sheetSelection.sheetNames.length;

        if (sheetName && total > 1) {
          setStatus(`Importando planilha ${formatNumber(index + 1)} de ${formatNumber(total)}: ${sheetName}`);
        }

        await importFile(selected, sheetName, index === 0 ? sheetSelection.workbookInspectionMs : null, destinationWorkspaceId);
      }
    } catch (error) {
      setStatus(String(error));
    }
  }
});

sheetFormEl?.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = Array.from(
    sheetListEl?.querySelectorAll<HTMLInputElement>('input[name="excel-sheet"]:checked') ?? [],
  ).map((input) => input.value);
  closeSheetModal(selected);
});

cancelSheetButton?.addEventListener("click", () => closeSheetModal(null));
cancelSheetXButton?.addEventListener("click", () => closeSheetModal(null));
sheetListEl?.addEventListener("change", updateSheetConfirmButton);
selectAllSheetsButton?.addEventListener("click", () => {
  sheetListEl?.querySelectorAll<HTMLInputElement>('input[name="excel-sheet"]').forEach((input) => {
    input.checked = true;
  });
  updateSheetConfirmButton();
});

workspaceDestinationFormEl?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (pendingImportSummary) {
    closeImportSummaryModal(true);
    return;
  }

  const destination = selectedWorkspaceDestinationDraft();

  if (destination) {
    closeWorkspaceDestinationModal(destination);
  }
});

workspaceDestinationContentEl?.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;

  if (target.name === "workspace-destination-mode") {
    selectedWorkspaceDestinationMode = target.value as WorkspaceDestinationMode;
    const nameInput = workspaceDestinationContentEl.querySelector<HTMLInputElement>("#workspace-destination-name");
    if (nameInput && workspaceDestinationFormEl) {
      workspaceDestinationFormEl.dataset.workspaceName = nameInput.value;
    }
    setWorkspaceDestinationError("");
    if (workspaceDestinationImport) {
      renderWorkspaceDestinationOptions(workspaceDestinationImport);
    }
  }

  if (target.name === "workspace-destination-existing" && workspaceDestinationFormEl) {
    workspaceDestinationFormEl.dataset.workspaceId = target.value;
    setWorkspaceDestinationError("");
  }
});

workspaceDestinationContentEl?.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;

  if (target.id === "workspace-destination-search") {
    workspaceDestinationSearch = target.value;
    if (workspaceDestinationImport) {
      renderWorkspaceDestinationOptions(workspaceDestinationImport);
      workspaceDestinationContentEl.querySelector<HTMLInputElement>("#workspace-destination-search")?.focus();
    }
  }

  if (target.id === "workspace-destination-name" && workspaceDestinationFormEl) {
    workspaceDestinationFormEl.dataset.workspaceName = target.value;
    setWorkspaceDestinationError("");
  }
});

cancelWorkspaceDestinationXButton?.addEventListener("click", () => {
  if (pendingImportSummary) {
    closeImportSummaryModal(false);
    return;
  }

  closeWorkspaceDestinationModal(null);
});

backWorkspaceDestinationButton?.addEventListener("click", () => {
  if (pendingImportSummary) {
    closeImportSummaryModal(false);
    return;
  }

  closeWorkspaceDestinationModal("back");
});

documentsListEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const menuButton = target.closest<HTMLButtonElement>("[data-menu-document-id]");
  const selectButton = target.closest<HTMLButtonElement>("[data-document-id]");

  if (menuButton) {
    event.stopPropagation();
    const documentId = menuButton.dataset.menuDocumentId ?? "";
    const rect = menuButton.getBoundingClientRect();
    documentMenuPosition = {
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - 44),
    };
    setOpenDocumentMenu(openDocumentMenuId === documentId ? null : documentId);
    return;
  }

  if (selectButton) {
    setOpenDocumentMenu(null);
    await selectDocument(selectButton.dataset.documentId ?? "");
  }
});

documentActionMenuEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const detailsButton = target.closest<HTMLButtonElement>("[data-details-document-id]");
  const renameButton = target.closest<HTMLButtonElement>("[data-rename-document-id]");
  const exportButton = target.closest<HTMLButtonElement>("[data-export-document-id]");
  const deleteButton = target.closest<HTMLButtonElement>("[data-delete-document-id]");

  if (detailsButton) {
    event.stopPropagation();
    openDetails(detailsButton.dataset.detailsDocumentId ?? "");
    return;
  }

  if (renameButton) {
    event.stopPropagation();
    openRename(renameButton.dataset.renameDocumentId ?? "");
    return;
  }

  if (exportButton) {
    event.stopPropagation();
    openExport(exportButton.dataset.exportDocumentId ?? "");
    return;
  }

  if (!deleteButton) {
    return;
  }

  event.stopPropagation();
  const documentId = deleteButton.dataset.deleteDocumentId ?? "";
  setOpenDocumentMenu(null);
  await removeDocument(documentId);
});

sidebarToggleButton?.addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  renderSidebarState();
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  if (openDocumentMenuId) {
    if (!target.closest(".document-menu-wrap") && !target.closest("#document-action-menu")) {
      setOpenDocumentMenu(null);
    }
  }

  if (openColumnMenu) {
    if (!target.closest("[data-column-menu-trigger]") && !target.closest("#column-action-menu")) {
      setOpenColumnMenu(null);
    }
  }

  if (sqlPopoverMode) {
    if (!target.closest("#sql-popover") && !target.closest(".sql-toolbar")) {
      closeSqlPopover();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sqlPopoverMode) {
    closeSqlPopover();
    return;
  }

  if (event.key === "Escape" && !sqlSaveModalEl?.classList.contains("hidden")) {
    closeSqlSaveModal();
    return;
  }

  if (event.key === "Escape" && activePopoverMode) {
    hideCellPopover();
    return;
  }

  if (event.key === "Escape" && deleteDocumentId) {
    closeDeleteModal(false);
    return;
  }

  if (event.key === "Escape" && columnSettingsOpen) {
    closeColumnsModal();
    return;
  }

  if (event.key === "Escape" && openDocumentMenuId) {
    setOpenDocumentMenu(null);
    return;
  }

  if (event.key === "Escape" && openColumnMenu) {
    setOpenColumnMenu(null);
    return;
  }

  if (event.key === "Escape" && profilingState.status !== "closed" && !activeCellEdit) {
    closeProfilingDrawer();
    return;
  }

  if (event.key === "Escape" && !aboutModalEl?.classList.contains("hidden")) {
    closeAboutModal();
    return;
  }

  if (event.key === "Escape" && !updateModalEl?.classList.contains("hidden")) {
    closeUpdateModal();
    return;
  }

  if (event.key === "Escape" && detailsDocumentId) {
    closeDetails();
    return;
  }

  if (event.key === "Escape" && renameDocumentId) {
    closeRename();
    return;
  }

  if (event.key === "Escape" && renameColumnName) {
    closeRenameColumn();
    return;
  }

  if (event.key === "Escape" && exportDocumentId) {
    closeExport();
  }
});

document.addEventListener("pointermove", (event) => {
  if (!resizeState || !currentPage) {
    return;
  }

  const width = clampColumnWidth(resizeState.startWidth + event.clientX - resizeState.startX);
  const visibleColumns = visibleColumnEntries(currentPage);
  setColumnWidth(resizeState.columnName, width, false);
  applyGridColumnWidths(visibleColumns);
});

document.addEventListener("pointerup", (event) => {
  if (!resizeState) {
    return;
  }

  if (event.pointerId !== resizeState.pointerId) {
    return;
  }

  writeColumnPreferences();
  document.body.classList.remove("is-column-resizing");
  resizeState = null;
});

detailsModalEl?.addEventListener("click", (event) => {
  if (event.target === detailsModalEl) {
    closeDetails();
  }
});

closeDetailsButton?.addEventListener("click", closeDetails);

renameModalEl?.addEventListener("click", (event) => {
  if (event.target === renameModalEl) {
    closeRename();
  }
});

cancelRenameXButton?.addEventListener("click", closeRename);

renameFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveRename();
});

renameColumnModalEl?.addEventListener("click", (event) => {
  if (event.target === renameColumnModalEl) {
    closeRenameColumn();
  }
});

cancelRenameColumnXButton?.addEventListener("click", closeRenameColumn);

renameColumnFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveRenameColumn();
});

exportModalEl?.addEventListener("click", (event) => {
  if (event.target === exportModalEl && !exportInProgress) {
    closeExport();
  }
});

cancelExportXButton?.addEventListener("click", closeExport);

exportFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runExport();
});

deleteModalEl?.addEventListener("click", (event) => {
  if (event.target === deleteModalEl) {
    closeDeleteModal(false);
  }
});

cancelDeleteButton?.addEventListener("click", () => closeDeleteModal(false));
cancelDeleteXButton?.addEventListener("click", () => closeDeleteModal(false));
confirmDeleteButton?.addEventListener("click", () => closeDeleteModal(true));

columnsModalEl?.addEventListener("click", (event) => {
  if (event.target === columnsModalEl) {
    closeColumnsModal();
  }
});

closeColumnsXButton?.addEventListener("click", closeColumnsModal);
closeColumnsButton?.addEventListener("click", closeColumnsModal);
showAllColumnsButton?.addEventListener("click", () => {
  showAllColumns().catch((error) => setStatus(String(error)));
});

columnsListEl?.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;

  if (!target.matches("[data-column-visibility]")) {
    return;
  }

  setColumnVisible(target.dataset.columnVisibility ?? "", target.checked).catch((error) =>
    setStatus(String(error)),
  );
});

updateModalEl?.addEventListener("click", (event) => {
  if (event.target === updateModalEl) {
    closeUpdateModal();
  }
});

closeUpdateXButton?.addEventListener("click", closeUpdateModal);
skipUpdateButton?.addEventListener("click", closeUpdateModal);
installUpdateButton?.addEventListener("click", updateNow);

openAboutButton?.addEventListener("click", openAboutModal);

aboutModalEl?.addEventListener("click", (event) => {
  if (event.target === aboutModalEl) {
    closeAboutModal();
  }
});

closeAboutXButton?.addEventListener("click", closeAboutModal);
closeAboutButton?.addEventListener("click", closeAboutModal);
manualUpdateCheckButton?.addEventListener("click", () => {
  runUpdateCheck("manual");
});

workspaceSelectEl?.addEventListener("change", async () => {
  await selectWorkspace(workspaceSelectEl.value);
});

loadWorkspaceButton?.addEventListener("click", loadSelectedWorkspaceForEdit);

createWorkspaceButton?.addEventListener("click", createWorkspace);

workspaceNameEl?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  await createWorkspace();
});

toggleSqlButton?.addEventListener("click", () => {
  sqlVisible = !sqlVisible;
  sqlShellEl?.classList.toggle("hidden", !sqlVisible);
  toggleSqlButton.textContent = sqlVisible ? "Ocultar SQL" : "Console SQL";
  syncSqlHighlight();
});

toggleGridDetailsButton?.addEventListener("click", () => {
  setGridDetailsVisible(!gridDetailsVisible);
});

closeGridDetailsButton?.addEventListener("click", () => {
  setGridDetailsVisible(false);
});

async function runCurrentSql() {
  if (!sqlQueryEl || !sqlStatusEl) {
    return;
  }

  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  if (runSqlButton) {
    runSqlButton.disabled = true;
    runSqlButton.textContent = "Executando...";
  }
  sqlStatusEl.textContent = "Executando consulta na grid principal...";
  renderSqlError(null);
  closeSqlPopover();
  lastSqlExecutionMs = null;
  if (saveSqlResultButton) saveSqlResultButton.classList.add("hidden");
  const query = sqlQueryEl.value;
  const startedAt = performance.now();

  try {
    dataMode = "sql";
    currentSqlQuery = query;
    currentSummary = null;
    currentPage = null;
    currentOffset = 0;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
    await loadPage(0);
    lastSqlExecutionMs = Math.round(performance.now() - startedAt);
    const resultPage = currentPage as TablePage | null;
    const totalRows = resultPage?.total_rows ?? 0;
    const limit = resultPage?.limit ?? 500;
    const limited = totalRows > limit ? ` - exibindo primeiras ${formatNumber(limit)}` : "";
    sqlStatusEl.textContent = `${formatNumber(totalRows)} linhas encontradas${limited} - ${formatDuration(lastSqlExecutionMs)}.`;
    if (saveSqlResultButton) saveSqlResultButton.classList.remove("hidden");
    recordSqlHistory(query, currentPage, lastSqlExecutionMs, null);
  } catch (error) {
    sqlStatusEl.textContent = "Consulta nao executada.";
    renderSqlError(friendlySqlError(error));
    recordSqlHistory(query, null, Math.round(performance.now() - startedAt), String(error));
  } finally {
    if (runSqlButton) {
      runSqlButton.disabled = false;
      runSqlButton.textContent = "Executar SQL";
    }
  }
}

runSqlButton?.addEventListener("click", () => {
  runCurrentSql().catch((error) => setStatus(String(error)));
});

clearSqlButton?.addEventListener("click", async () => {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  dataMode = "document";
  currentSqlQuery = null;
  currentPage = null;
  filterValues = new Map();
  sortColumn = null;
  sortDirection = null;
  if (sqlStatusEl) sqlStatusEl.textContent = "Resultado SQL limpo.";
  if (saveSqlResultButton) saveSqlResultButton.classList.add("hidden");
  renderSqlError(null);
  await loadPage(0);
});

sqlQueryEl?.addEventListener("input", () => {
  syncSqlHighlight();
  updateSqlAutocomplete();
});
sqlQueryEl?.addEventListener("scroll", () => {
  if (!sqlQueryEl || !sqlHighlightEl) return;
  sqlHighlightEl.scrollTop = sqlQueryEl.scrollTop;
  sqlHighlightEl.scrollLeft = sqlQueryEl.scrollLeft;
});
sqlQueryEl?.addEventListener("focus", updateSqlAutocomplete);
sqlQueryEl?.addEventListener("click", updateSqlAutocomplete);
sqlQueryEl?.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runCurrentSql().catch((error) => setStatus(String(error)));
    return;
  }

  if (!sqlAutocompleteOpen) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    sqlAutocompleteIndex = (sqlAutocompleteIndex + 1) % sqlAutocompleteItems.length;
    renderSqlAutocomplete();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    sqlAutocompleteIndex = (sqlAutocompleteIndex - 1 + sqlAutocompleteItems.length) % sqlAutocompleteItems.length;
    renderSqlAutocomplete();
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    applySqlSuggestion();
  } else if (event.key === "Escape") {
    sqlAutocompleteOpen = false;
    renderSqlAutocomplete();
  }
});

sqlContextModeEl?.addEventListener("change", () => {
  sqlContextMode = sqlContextModeEl.value === "workspace" ? "workspace" : "document";
  closeSqlPopover();
  sqlAutocompleteOpen = false;
  renderSqlContext();
  refreshSqlSources().catch((error) => setStatus(String(error)));
});

sqlAutocompleteEl?.addEventListener("mousedown", (event) => {
  event.preventDefault();
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sql-suggestion]");
  if (!button) return;
  applySqlSuggestion(Number(button.dataset.sqlSuggestion));
});

sqlColumnsButton?.addEventListener("click", () => toggleSqlPopover("columns"));
sqlHistoryButton?.addEventListener("click", () => toggleSqlPopover("history"));
sqlSavedButton?.addEventListener("click", () => toggleSqlPopover("saved"));
sqlMenuButton?.addEventListener("click", () => toggleSqlPopover("menu"));

sqlPopoverEl?.addEventListener("input", (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>("#sql-column-search");
  if (!input) return;
  sqlColumnSearch = input.value;
  renderSqlPopover();
});

sqlPopoverEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const columnButton = target.closest<HTMLButtonElement>("[data-insert-column]");
  const sourceButton = target.closest<HTMLButtonElement>("[data-insert-source]");
  const historyButton = target.closest<HTMLButtonElement>("[data-load-history]");
  const savedButton = target.closest<HTMLButtonElement>("[data-load-saved]");
  const saveCurrentButton = target.closest<HTMLButtonElement>("[data-save-current-query]");
  const menuButton = target.closest<HTMLButtonElement>("[data-sql-menu-action]");

  if (columnButton) {
    insertSqlText(sqlIdentifier(columnButton.dataset.insertColumn ?? ""), null);
    return;
  }

  if (sourceButton) {
    insertSqlText(sqlIdentifier(sourceButton.dataset.insertSource ?? ""), null);
    return;
  }

  if (historyButton) {
    const entry = sqlHistory.find((item) => item.id === historyButton.dataset.loadHistory);
    if (entry) {
      restoreSqlEntryContext(entry);
      setSqlEditorValue(entry.query);
    }
    closeSqlPopover();
    return;
  }

  if (savedButton) {
    const entry = savedSqlQueries.find((item) => item.id === savedButton.dataset.loadSaved);
    if (entry) {
      restoreSqlEntryContext(entry);
      setSqlEditorValue(entry.query);
    }
    closeSqlPopover();
    return;
  }

  if (saveCurrentButton) {
    openSqlSaveModal("query");
    return;
  }

  if (menuButton) {
    const action = menuButton.dataset.sqlMenuAction;
    if (action === "format") {
      formatSqlQuery();
    } else if (action === "save") {
      openSqlSaveModal("query");
    } else if (action === "copy" && sqlQueryEl) {
      await navigator.clipboard?.writeText(sqlQueryEl.value);
      if (sqlStatusEl) sqlStatusEl.textContent = "SQL copiado.";
    }
    closeSqlPopover();
  }
});

sqlErrorEl?.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-sql-fix]")) {
    applySqlErrorFix();
  }
});

saveSqlResultButton?.addEventListener("click", () => openSqlSaveModal("result"));
cancelSqlSaveXButton?.addEventListener("click", closeSqlSaveModal);
cancelSqlSaveButton?.addEventListener("click", closeSqlSaveModal);
sqlSaveModalEl?.addEventListener("click", (event) => {
  if (event.target === sqlSaveModalEl) {
    closeSqlSaveModal();
  }
});

sqlSaveFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = sqlSaveNameEl?.value.trim() ?? "";

  if (!sqlSaveMode || !sqlQueryEl || !name) {
    if (sqlSaveErrorEl) {
      sqlSaveErrorEl.textContent = "Digite um nome.";
      sqlSaveErrorEl.classList.remove("hidden");
    }
    sqlSaveNameEl?.focus();
    return;
  }

  if (confirmSqlSaveButton) confirmSqlSaveButton.disabled = true;
  if (sqlSaveErrorEl) sqlSaveErrorEl.classList.add("hidden");

  try {
    if (sqlSaveMode === "query") {
      savedSqlQueries = [
        {
          id: `saved_sql_${Date.now()}`,
          name,
          query: sqlQueryEl.value,
          contextMode: sqlContextMode,
          documentId: sqlContextMode === "document" ? currentDocumentId : null,
          workspaceId: currentWorkspaceId,
          savedAt: Date.now(),
        },
        ...savedSqlQueries.filter((entry) => entry.name !== name),
      ];
      writeSavedSqlQueries();
      if (sqlStatusEl) sqlStatusEl.textContent = "Consulta salva.";
      closeSqlSaveModal();
      if (sqlPopoverMode === "saved") renderSqlPopover();
      return;
    }

    const savedDocument = await invoke<DocumentInfo>("save_sql_result_document", {
      query: currentSqlQuery ?? sqlQueryEl.value,
      name,
      contextMode: sqlContextMode,
      workspaceId: currentWorkspaceId,
      sourceDocumentId: sqlContextMode === "document" ? currentDocumentId : null,
    });
    documents = [savedDocument, ...documents.filter((document) => document.id !== savedDocument.id)];
    currentDocumentId = savedDocument.id;
    dataMode = "document";
    currentSqlQuery = null;
    currentSummary = null;
    currentPage = null;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
    if (saveSqlResultButton) saveSqlResultButton.classList.add("hidden");
    closeSqlSaveModal();
    renderDocuments();
    renderSqlContext();
    refreshSqlSources().catch((error) => setStatus(String(error)));
    await loadPage(0);
    setStatus("Resultado SQL salvo como documento.");
    if (sqlStatusEl) sqlStatusEl.textContent = "Resultado salvo como documento.";
  } catch (error) {
    if (sqlSaveErrorEl) {
      sqlSaveErrorEl.textContent = String(error);
      sqlSaveErrorEl.classList.remove("hidden");
    }
  } finally {
    if (confirmSqlSaveButton) confirmSqlSaveButton.disabled = false;
  }
});

tableHeadEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const resizeHandle = target.closest<HTMLButtonElement>("[data-resize-visible-column]");

  if (resizeHandle) {
    return;
  }

  const menuButton = target.closest<HTMLButtonElement>("[data-column-menu-trigger]");

  if (menuButton) {
    event.stopPropagation();
    const column = menuButton.dataset.columnMenuTrigger ?? "";
    const index = Number(menuButton.dataset.columnMenuIndex);
    const rect = menuButton.getBoundingClientRect();
    columnMenuPosition = {
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(window.innerWidth - 210, rect.right - 190)),
    };
    setOpenColumnMenu(
      openColumnMenu?.column === column
        ? null
        : {
            column,
            index: Number.isInteger(index) ? index : -1,
          },
    );
    return;
  }

  const button = target.closest<HTMLButtonElement>("[data-sort-column]");

  if (!button) {
    return;
  }

  const column = button.dataset.sortColumn ?? "";

  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  if (sortColumn !== column) {
    sortColumn = column;
    sortDirection = "asc";
  } else if (sortDirection === "asc") {
    sortDirection = "desc";
  } else {
    sortColumn = null;
    sortDirection = null;
  }

  await loadPage(0);
});

columnActionMenuEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const actionButton = target.closest<HTMLButtonElement>("[data-column-menu-action]");

  if (!actionButton || !openColumnMenu) {
    return;
  }

  event.stopPropagation();
  const action = actionButton.dataset.columnMenuAction;
  const { column, index } = openColumnMenu;
  setOpenColumnMenu(null);

  if (action === "focus-filter") {
    focusColumnFilter(column);
    return;
  }

  if (action === "profile") {
    profilingState = { ...profilingState, activeTab: "profile" };
    await openColumnProfile(column);
    return;
  }

  if (action === "quality") {
    profilingState = { ...profilingState, activeTab: "quality" };
    await openColumnProfile(column);
    return;
  }

  if (action === "transform") {
    profilingState = { ...profilingState, activeTab: "transform" };
    await openColumnProfile(column);
    return;
  }

  if (action === "rename") {
    if (Number.isInteger(index) && index >= 0) {
      openRenameColumn(index);
    }
    return;
  }

  if (action === "hide") {
    await setColumnVisible(column, false);
    return;
  }

  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  if (action === "sort-asc" || action === "sort-desc") {
    sortColumn = column;
    sortDirection = action === "sort-desc" ? "desc" : "asc";
    await loadPage(0);
  }
});

tableHeadEl?.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  const resizeHandle = target.closest<HTMLButtonElement>("[data-resize-visible-column]");

  if (!resizeHandle || !currentPage) {
    return;
  }

  const visibleIndex = Number(resizeHandle.dataset.resizeVisibleColumn);
  const columnName = resizeHandle.dataset.resizeColumn ?? "";

  if (!Number.isInteger(visibleIndex) || !columnName) {
    return;
  }

  event.preventDefault();
  resizeHandle.setPointerCapture(event.pointerId);
  resizeState = {
    pointerId: event.pointerId,
    visibleIndex,
    columnName,
    startX: event.clientX,
    startWidth: columnWidth(columnName),
  };
  document.body.classList.add("is-column-resizing");
});

tableHeadEl?.addEventListener("dblclick", (event) => {
  const target = event.target as HTMLElement;
  const resizeHandle = target.closest<HTMLButtonElement>("[data-resize-visible-column]");

  if (!resizeHandle || !currentPage) {
    return;
  }

  const visibleIndex = Number(resizeHandle.dataset.resizeVisibleColumn);
  const columnName = resizeHandle.dataset.resizeColumn ?? "";

  if (!Number.isInteger(visibleIndex) || !columnName) {
    return;
  }

  event.preventDefault();
  setColumnWidth(columnName, autoFitColumnWidth(visibleIndex, columnName));
  applyGridColumnWidths(visibleColumnEntries(currentPage));
});

tableHeadEl?.addEventListener("input", async (event) => {
  const target = event.target as HTMLInputElement;

  if (!target.matches("[data-filter-column]")) {
    return;
  }

  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  const column = target.dataset.filterColumn ?? "";
  setContainsFilter(column, target.value);
  renderSummary(currentSummary, currentPage);
  scheduleFilterReload();
});

tableBodyEl?.addEventListener("keydown", async (event) => {
  const target = event.target as HTMLElement;
  const editor = target.closest<HTMLInputElement | HTMLTextAreaElement>("[data-cell-editor]");

  if (editor && activeCellEdit) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelActiveCellEdit();
      return;
    }

    if (event.key === "Enter" && !(editor instanceof HTMLTextAreaElement && event.shiftKey)) {
      event.preventDefault();
      await commitActiveCellEdit();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const position = activeEditPosition();
      const committed = await commitActiveCellEdit();

      if (committed && position) {
        await moveCellFocus(position, event.shiftKey ? "previous-column" : "next-column");
      }

      return;
    }

    return;
  }

  const navigationByKey: Record<string, "next-column" | "previous-column" | "next-row" | "previous-row"> = {
    ArrowDown: "next-row",
    ArrowLeft: "previous-column",
    ArrowRight: "next-column",
    ArrowUp: "previous-row",
  };

  if (event.key !== "Tab" && event.key !== "Enter" && event.key !== "F2" && !(event.key in navigationByKey)) {
    return;
  }

  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (!cell) {
    return;
  }

  const row = Number(cell.dataset.cellRow);
  const column = Number(cell.dataset.cellColumn);

  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return;
  }

  event.preventDefault();

  if (event.key === "Enter" || event.key === "F2") {
    startCellEdit(cell);
    return;
  }

  await moveCellFocus(
    { row, column },
    navigationByKey[event.key] ??
      (event.key === "Tab"
        ? event.shiftKey
          ? "previous-column"
          : "next-column"
        : event.shiftKey
          ? "previous-row"
          : "next-row"),
  );
});

tableBodyEl?.addEventListener("focusin", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("[data-cell-editor]")) {
    return;
  }

  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (cell) {
    selectCell(cell);
  }
});

tableBodyEl?.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;

  if (!target.matches("[data-cell-editor]")) {
    return;
  }

  updateActiveEditDraft(target instanceof HTMLInputElement && target.type === "checkbox" ? String(target.checked) : target.value);
});

tableBodyEl?.addEventListener("focusout", (event) => {
  const nextTarget = event.relatedTarget;

  if (nextTarget instanceof Node && tableBodyEl.contains(nextTarget)) {
    return;
  }

  hideCellPopover("selection");
});

tableBodyEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("[data-cell-editor]")) {
    return;
  }

  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (cell) {
    const state = cellStateFromElement(cell);

    if (activeCellEdit && state && !isSameCell(activeCellEdit, state)) {
      const committed = await commitActiveCellEdit();

      if (!committed) {
        return;
      }
    }

    selectCell(cell);
  }
});

tableBodyEl?.addEventListener("dblclick", (event) => {
  const target = event.target as HTMLElement;

  if (target.closest("[data-cell-editor]")) {
    return;
  }

  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (cell) {
    startCellEdit(cell);
  }
});

tableBodyEl?.addEventListener("pointerover", (event) => {
  if (activePopoverMode === "selection") {
    return;
  }

  const target = event.target as HTMLElement;
  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (!cell) {
    return;
  }

  const state = cellStateFromElement(cell);

  if (state) {
    showCellPopover(cell, cellDisplayValue(state.value), "hover");
  }
});

tableBodyEl?.addEventListener("pointerout", (event) => {
  if (activePopoverMode !== "hover") {
    return;
  }

  const target = event.target as HTMLElement;
  const cell = target.closest<HTMLElement>("[data-cell-row][data-cell-column]");

  if (!cell || cell.contains(event.relatedTarget as Node | null)) {
    return;
  }

  hideCellPopover("hover");
});

tableViewportEl?.addEventListener("scroll", () => {
  if (activeCellEdit?.status === "editing") {
    const { start, end } = visibleRowBounds();

    if (activeCellEdit.row < start || activeCellEdit.row >= end) {
      commitActiveCellEdit().catch((error) => setStatus(String(error)));
      return;
    }
  }

  scheduleVirtualRender();
  if (activePopoverMode === "selection") {
    window.requestAnimationFrame(repositionSelectedCellPopover);
  } else {
    hideCellPopover("hover");
  }
}, { passive: true });

prevButton?.addEventListener("click", async () => {
  if (!currentPage) return;
  await loadPage(Math.max(0, currentOffset - PAGE_SIZE));
});

nextButton?.addEventListener("click", async () => {
  if (!currentPage) return;
  const nextOffset = currentOffset + PAGE_SIZE;
  if (nextOffset < currentPage.total_rows) {
    await loadPage(nextOffset);
  }
});

clearFiltersButton?.addEventListener("click", async () => {
  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  filterValues = new Map();
  sortColumn = null;
  sortDirection = null;
  await loadPage(0);
});

openColumnsButton?.addEventListener("click", openColumnsModal);

renderSummary(null);
renderSidebarState();
renderWorkspaces();
renderGridDetailsVisibility();
renderQuality(null);
renderTable(null);
syncSqlHighlight();
getInstalledVersion()
  .then((version) => {
    installedVersion = version;
    renderInstalledVersion();
  })
  .catch((error) => {
    console.error("Falha ao obter versao instalada.", error);
  });
window.setTimeout(() => {
  runUpdateCheck("auto");
}, 1200);
refreshWorkspaces()
  .then(refreshDocuments)
  .then(() => {
    if (currentDocumentId) {
      return loadPage(0);
    }

    return undefined;
  })
  .catch((error) => setStatus(String(error)));
