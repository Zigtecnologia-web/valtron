import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
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
  rows: string[][];
  total_rows: number;
  offset: number;
  limit: number;
  sort_column: string | null;
  sort_direction: "asc" | "desc" | null;
  filters: ColumnFilter[];
  stats: TableStats;
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

type ExportFormat = "csv" | "tsv" | "xlsx";

const PAGE_SIZE = 100;

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
let exportDocumentId: string | null = null;
let exportInProgress = false;
let deleteDocumentId: string | null = null;
let resolveDeleteConfirmation: ((confirmed: boolean) => void) | null = null;

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

    <section class="content-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">DuckDB Data Studio</p>
          <h1>Valtron</h1>
        </div>
        <div class="topbar-actions">
          <button id="toggle-grid-details" class="ghost-button" type="button">Detalhes</button>
          <button id="toggle-sql" class="ghost-button" type="button">Console SQL</button>
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
          <button id="clear-filters" class="ghost-button" type="button" disabled>Limpar filtros</button>
          <button id="prev-page" class="ghost-button" type="button" disabled>Anterior</button>
          <button id="next-page" class="ghost-button" type="button" disabled>Proxima</button>
        </div>
      </div>

      <div class="table-viewport">
        <table>
          <thead id="table-head"></thead>
          <tbody id="table-body">
            <tr>
              <td class="empty-cell">Importe um arquivo para visualizar os dados.</td>
            </tr>
          </tbody>
        </table>
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
const tableHeadEl = document.querySelector<HTMLTableSectionElement>("#table-head");
const tableBodyEl = document.querySelector<HTMLTableSectionElement>("#table-body");
const prevButton = document.querySelector<HTMLButtonElement>("#prev-page");
const nextButton = document.querySelector<HTMLButtonElement>("#next-page");
const clearFiltersButton = document.querySelector<HTMLButtonElement>("#clear-filters");

function setStatus(message: string) {
  if (statusEl) {
    statusEl.textContent = message;
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

function filterValue(column: string) {
  return filterValues.get(column) ?? "";
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
    Array.from(tableBodyEl.querySelectorAll<HTMLTableCellElement>("[data-cell-row][data-cell-column]"))
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
  if (!pendingCellFocus || !currentPage || currentPage.rows.length === 0) {
    pendingCellFocus = null;
    return;
  }

  const target = {
    row: Math.min(pendingCellFocus.row, currentPage.rows.length - 1),
    column: Math.min(pendingCellFocus.column, currentPage.columns.length - 1),
  };

  pendingCellFocus = null;
  focusCell(target);
}

async function moveCellFocus(position: CellPosition, direction: "next-column" | "previous-column" | "next-row" | "previous-row") {
  if (!currentPage || currentPage.columns.length === 0 || currentPage.rows.length === 0) {
    return;
  }

  let nextRow = position.row;
  let nextColumn = position.column;

  if (direction === "next-column") {
    nextColumn += 1;

    if (nextColumn >= currentPage.columns.length) {
      nextColumn = 0;
      nextRow += 1;
    }
  }

  if (direction === "previous-column") {
    nextColumn -= 1;

    if (nextColumn < 0) {
      nextColumn = currentPage.columns.length - 1;
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
    if (currentOffset === 0) {
      focusCell(position);
      return;
    }

    pendingCellFocus = {
      row: PAGE_SIZE - 1,
      column: nextColumn,
    };
    await loadPage(Math.max(0, currentOffset - PAGE_SIZE));
    return;
  }

  if (nextRow >= currentPage.rows.length) {
    const nextOffset = currentOffset + currentPage.limit;

    if (nextOffset >= currentPage.total_rows) {
      focusCell(position);
      return;
    }

    pendingCellFocus = {
      row: 0,
      column: nextColumn,
    };
    await loadPage(nextOffset);
    return;
  }

  focusCell({
    row: nextRow,
    column: nextColumn,
  });
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
      <tr>
        <td class="empty-cell">Importe um arquivo para visualizar os dados.</td>
      </tr>
    `;
    tableSubtitleEl.textContent = "Aguardando importacao.";
    pageRangeEl.textContent = "-";
    renderQuality(null);
    return;
  }

  const firstRow = page.total_rows === 0 ? 0 : page.offset + 1;
  const lastRow = Math.min(page.offset + page.rows.length, page.total_rows);

  tableHeadEl.innerHTML = `
    <tr>
      ${page.columns
        .map(
          (column) => `
            <th>
              <button class="column-sort" type="button" data-sort-column="${escapeHtml(column)}">
                <span>${escapeHtml(column)}</span>
                <strong>${sortIndicator(column)}</strong>
              </button>
            </th>
          `,
        )
        .join("")}
    </tr>
    <tr class="filter-row">
      ${page.columns
        .map(
          (column) => `
            <th>
              <input
                class="column-filter"
                data-filter-column="${escapeHtml(column)}"
                placeholder="Filtrar"
                value="${escapeHtml(filterValue(column))}"
              />
            </th>
          `,
        )
        .join("")}
    </tr>
  `;
  tableBodyEl.innerHTML =
    page.rows.length === 0
      ? `
        <tr>
          <td class="empty-cell" colspan="${page.columns.length}">Nenhuma linha encontrada.</td>
        </tr>
      `
      : page.rows
          .map(
            (row, rowIndex) => `
              <tr>
                ${page.columns
                  .map(
                    (_, index) => `
                      <td
                        class="data-cell"
                        tabindex="0"
                        data-cell-row="${rowIndex}"
                        data-cell-column="${index}"
                      >${escapeHtml(row[index] ?? "")}</td>
                    `,
                  )
                  .join("")}
              </tr>
            `,
          )
          .join("");

  tableSubtitleEl.textContent =
    dataMode === "sql"
      ? `${formatNumber(page.total_rows)} linhas no resultado SQL`
      : `${formatNumber(page.total_rows)} linhas na consulta atual`;
  pageRangeEl.textContent =
    page.total_rows === 0
      ? "0"
      : `${formatNumber(firstRow)}-${formatNumber(lastRow)}`;

  if (prevButton) prevButton.disabled = page.offset === 0;
  if (nextButton) nextButton.disabled = page.offset + page.limit >= page.total_rows;
  if (clearFiltersButton) clearFiltersButton.disabled = activeFilters().length === 0 && !sortColumn;

  renderQuality(page.stats);
  restoreFilterFocus(filterFocus);
  restorePendingCellFocus();
}

async function loadPage(offset: number) {
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

  setStatus("Carregando pagina...");
  showLoading("Carregando dados...");

  try {
    currentPage =
      dataMode === "sql"
        ? await invoke<TablePage>("get_sql_page", {
            query: currentSqlQuery,
            offset,
            limit: PAGE_SIZE,
            filters: activeFilters(),
            sortColumn,
            sortDirection,
          })
        : await invoke<TablePage>("get_table_page", {
            documentId: currentDocumentId,
            offset,
            limit: PAGE_SIZE,
            filters: activeFilters(),
            sortColumn,
            sortDirection,
          });
    currentOffset = currentPage.offset;
    sortColumn = currentPage.sort_column;
    sortDirection = currentPage.sort_direction;
    renderSummary(currentSummary, currentPage);
    renderTable(currentPage);
    setStatus("Dados carregados.");
  } finally {
    hideLoading();
  }
}

function scheduleFilterReload() {
  if (filterTimer) {
    window.clearTimeout(filterTimer);
  }

  filterTimer = window.setTimeout(() => {
    loadPage(0).catch((error) => setStatus(String(error)));
  }, 350);
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
  if (event.key === "Escape" && deleteDocumentId) {
    closeDeleteModal(false);
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

  if (event.key === "Escape" && exportDocumentId) {
    closeExport();
  }
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
  const button = target.closest<HTMLButtonElement>("[data-sort-column]");

  if (!button) {
    return;
  }

  const column = button.dataset.sortColumn ?? "";

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

tableHeadEl?.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;

  if (!target.matches("[data-filter-column]")) {
    return;
  }

  const column = target.dataset.filterColumn ?? "";
  filterValues.set(column, target.value);
  renderSummary(currentSummary, currentPage);
  scheduleFilterReload();
});

tableBodyEl?.addEventListener("keydown", async (event) => {
  const navigationByKey: Record<string, "next-column" | "previous-column" | "next-row" | "previous-row"> = {
    ArrowDown: "next-row",
    ArrowLeft: "previous-column",
    ArrowRight: "next-column",
    ArrowUp: "previous-row",
  };

  if (event.key !== "Tab" && event.key !== "Enter" && !(event.key in navigationByKey)) {
    return;
  }

  const target = event.target as HTMLElement;
  const cell = target.closest<HTMLTableCellElement>("[data-cell-row][data-cell-column]");

  if (!cell) {
    return;
  }

  const row = Number(cell.dataset.cellRow);
  const column = Number(cell.dataset.cellColumn);

  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return;
  }

  event.preventDefault();

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
  filterValues = new Map();
  sortColumn = null;
  sortDirection = null;
  await loadPage(0);
});

renderSummary(null);
renderSidebarState();
renderWorkspaces();
renderGridDetailsVisibility();
renderQuality(null);
renderTable(null);
syncSqlHighlight();
refreshWorkspaces()
  .then(refreshDocuments)
  .then(() => {
    if (currentDocumentId) {
      return loadPage(0);
    }

    return undefined;
  })
  .catch((error) => setStatus(String(error)));
