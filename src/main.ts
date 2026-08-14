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

type WorkspaceInfo = {
  id: string;
  name: string;
  created_at: string;
  document_count: number;
};

type ColumnFilter = {
  column: string;
  value: string;
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
let filterValues = new Map<string, string>();
let filterTimer: number | undefined;
let gridDetailsVisible = false;
let sqlVisible = false;
let dataMode: "document" | "sql" = "document";
let currentSqlQuery: string | null = null;
let loadingCount = 0;
let pendingCellFocus: CellPosition | null = null;
let sidebarCollapsed = true;
let openDocumentMenuId: string | null = null;
let documentMenuPosition = { top: 0, left: 0 };
let editingWorkspaceId: string | null = null;
let detailsDocumentId: string | null = null;
let renameDocumentId: string | null = null;
let renameColumnName: string | null = null;
let renameColumnIndex: number | null = null;
let exportDocumentId: string | null = null;
let exportInProgress = false;
let deleteDocumentId: string | null = null;
let resolveDeleteConfirmation: ((confirmed: boolean) => void) | null = null;
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
        <div class="sql-code-wrap">
          <pre id="sql-highlight" aria-hidden="true"></pre>
          <textarea id="sql-query" spellcheck="false">SELECT * FROM imported_documents;</textarea>
        </div>
        <div class="sql-actions">
          <button id="run-sql" class="primary-button" type="button">Executar SQL</button>
          <button id="clear-sql" class="ghost-button" type="button">Voltar documento</button>
        </div>
      </div>
      <p id="sql-status" class="toolbar-subtitle">O resultado vai aparecer na grid principal.</p>
    </section>

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
const sqlStatusEl = document.querySelector<HTMLParagraphElement>("#sql-status");
const runSqlButton = document.querySelector<HTMLButtonElement>("#run-sql");
const clearSqlButton = document.querySelector<HTMLButtonElement>("#clear-sql");
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

function setStatus(message: string) {
  if (statusEl) {
    statusEl.textContent = message;
  }
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

function highlightSql(value: string) {
  return escapeHtml(value)
    .replace(
      /\b(SELECT|FROM|WHERE|GROUP|BY|ORDER|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|WITH|COUNT|SUM|AVG|MIN|MAX|DISTINCT|CASE|WHEN|THEN|ELSE|END|HAVING|DESC|ASC|NULL|IS|LIKE|NOT|IN)\b/gi,
      '<span class="sql-token-keyword">$1</span>',
    )
    .replace(/('[^']*')/g, '<span class="sql-token-string">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="sql-token-number">$1</span>');
}

function syncSqlHighlight() {
  if (!sqlQueryEl || !sqlHighlightEl) {
    return;
  }

  sqlHighlightEl.innerHTML = `${highlightSql(sqlQueryEl.value)}\n`;
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
  return Array.from(filterValues.entries())
    .filter(([, value]) => value.trim().length > 0)
    .map(([column, value]) => ({ column, value: value.trim() }));
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
  return filterValues.get(column) ?? "";
}

function renameColumnInLocalState(oldColumn: string, newColumn: string) {
  const activeFilter = filterValues.get(oldColumn);

  if (activeFilter !== undefined) {
    filterValues.delete(oldColumn);
    filterValues.set(newColumn, activeFilter);
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

    const hadActiveFilter = filterValue(column).trim().length > 0;
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
    activeCellEdit = null;
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
          ({ column, index }, visibleIndex) => `
            <div class="grid-header-cell" data-header-visible-column="${visibleIndex}" data-header-column="${escapeHtml(column)}">
              <div class="column-header">
                ${
                  dataMode === "document"
                    ? `<span class="column-edit-wrap">
                        <button class="column-edit" type="button" data-edit-column-index="${index}" aria-label="Alterar ${escapeHtml(column)}">&#9998;</button>
                        <span class="document-tooltip column-edit-tooltip" role="tooltip">Alterar ${escapeHtml(column)}</span>
                      </span>`
                    : ""
                }
                <button class="column-sort" type="button" data-sort-column="${escapeHtml(column)}" title="${escapeHtml(column)}">
                  <span>${escapeHtml(column)}</span>
                  <strong>${sortIndicator(column)}</strong>
                </button>
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
          `,
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

async function importFile(path: string) {
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
      workspaceId: currentWorkspaceId,
    });
    currentDocumentId = currentSummary.document_id;
    await refreshWorkspaces();
    await refreshDocuments();
    renderSummary(currentSummary, null);
    await loadPage(0);
    setStatus("Importacao concluida.");
  } catch (error) {
    setStatus(String(error));
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
  renderSummary(null, null);
  renderQuality(null);
  renderTable(null);
  renderWorkspaces();
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
  renderDocuments();
  await loadPage(0);
}

async function removeDocument(documentId: string) {
  if (!(await confirmDeleteDocument(documentId))) {
    return;
  }

  setStatus("Deletando documento...");
  await invoke("delete_document", { documentId });
  localStorage.removeItem(columnVisibilityStorageKey(documentId));

  if (currentDocumentId === documentId) {
    currentDocumentId = null;
    currentSummary = null;
    currentPage = null;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
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
    await importFile(selected);
  }
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
  if (!openDocumentMenuId) {
    return;
  }

  const target = event.target as HTMLElement;

  if (target.closest(".document-menu-wrap") || target.closest("#document-action-menu")) {
    return;
  }

  setOpenDocumentMenu(null);
});

document.addEventListener("keydown", (event) => {
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

  if (event.key === "Escape" && !aboutModalEl?.classList.contains("hidden")) {
    closeAboutModal();
    return;
  }

  if (event.key === "Escape" && !updateModalEl?.classList.contains("hidden")) {
    closeUpdateModal();
    return;
  }

  if (event.key === "Escape" && openDocumentMenuId) {
    setOpenDocumentMenu(null);
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

runSqlButton?.addEventListener("click", async () => {
  if (!sqlQueryEl || !sqlStatusEl) {
    return;
  }

  if (!(await resolveActiveCellEditBeforeGridChange())) {
    setStatus("Aguarde a atualizacao da celula atual.");
    return;
  }

  runSqlButton.disabled = true;
  sqlStatusEl.textContent = "Executando consulta na grid principal...";

  try {
    dataMode = "sql";
    currentSqlQuery = sqlQueryEl.value;
    currentSummary = null;
    currentPage = null;
    currentOffset = 0;
    filterValues = new Map();
    sortColumn = null;
    sortDirection = null;
    await loadPage(0);
    sqlStatusEl.textContent = "Resultado exibido na grid principal.";
  } catch (error) {
    sqlStatusEl.textContent = String(error);
  } finally {
    runSqlButton.disabled = false;
  }
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
  await loadPage(0);
});

sqlQueryEl?.addEventListener("input", syncSqlHighlight);
sqlQueryEl?.addEventListener("scroll", () => {
  if (!sqlQueryEl || !sqlHighlightEl) return;
  sqlHighlightEl.scrollTop = sqlQueryEl.scrollTop;
  sqlHighlightEl.scrollLeft = sqlQueryEl.scrollLeft;
});

tableHeadEl?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const resizeHandle = target.closest<HTMLButtonElement>("[data-resize-visible-column]");

  if (resizeHandle) {
    return;
  }

  const editButton = target.closest<HTMLButtonElement>("[data-edit-column-index]");

  if (editButton) {
    if (!(await resolveActiveCellEditBeforeGridChange())) {
      setStatus("Aguarde a atualizacao da celula atual.");
      return;
    }

    const columnIndex = Number(editButton.dataset.editColumnIndex);

    if (Number.isInteger(columnIndex)) {
      openRenameColumn(columnIndex);
    }

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
  filterValues.set(column, target.value);
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
