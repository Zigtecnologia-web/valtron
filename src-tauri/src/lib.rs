use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, BufWriter, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use calamine::{open_workbook, DataRef, Reader, Xlsx};
use duckdb::{
    arrow::{
        array::{ArrayRef, StringArray},
        datatypes::{DataType, Field, Schema, SchemaRef},
        record_batch::RecordBatch,
    },
    params, params_from_iter,
    types::ValueRef,
    Connection, ToSql,
};
use quick_xml::{events::Event, Reader as XmlReader, XmlVersion};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

mod date;
mod quality;
mod transformations;

const DOCUMENTS_TABLE: &str = "imported_documents";
const SQL_LINEAGE_TABLE: &str = "sql_result_lineage";
const WORKSPACES_TABLE: &str = "workspaces";
const VALTRON_ROW_ID_COLUMN: &str = "_valtron_row_id";
const DUCKDB_ROW_ID_ALIAS: &str = "__valtron_duckdb_rowid";
const DEFAULT_WORKSPACE_ID: &str = "default";
const MAX_COLUMNS: usize = 16_384;
const MAX_HEADER_SCAN_ROWS: u32 = 20;
const PROFILE_BUCKET_COUNT: i64 = 12;
const EXCEL_SERIAL_DATE_INFERENCE_THRESHOLD: f64 = 0.90;

fn log_excel_import_error(stage: &str, sheet_name: Option<&str>, error: &str, duration: Duration) {
    let sheet_name = sheet_name.unwrap_or("");
    eprintln!(
        "EXCEL_IMPORT_ERROR\nstage: {stage}\nsheet_name: {sheet_name}\nerror: {error}\nduration_ms: {}",
        duration.as_millis()
    );
}

#[derive(Default)]
struct AppState {
    column_profile_cache: Mutex<HashMap<String, ColumnProfile>>,
    quality_cache: Mutex<HashMap<String, quality::QualityValidationSummary>>,
    quality_revisions: Mutex<HashMap<String, u64>>,
    transformation_locks: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct ImportPerformance {
    file_open: Duration,
    xlsx_open: Duration,
    worksheets_read: Duration,
    excel_workbook_inspection: Duration,
    excel_header_detection: Duration,
    excel_sheet_import: Duration,
    csv_generation: Duration,
    cell_conversion: Duration,
    validation: Duration,
    data_preparation: Duration,
    duckdb: Duration,
    auxiliary_structures: Duration,
    frontend_events: Duration,
    duckdb_detail: DuckDbPerformance,
    batch_detail: BatchPerformance,
}

#[derive(Default)]
struct DuckDbPerformance {
    table_cleanup: Duration,
    table_creation: Duration,
    xlsx_import: Duration,
    copy: Duration,
    arrow_ingestion: Duration,
    appender: Duration,
    flush: Duration,
    commit: Duration,
    final_queries: Duration,
}

#[derive(Default)]
struct BatchPerformance {
    batch_size: usize,
    batch_count: usize,
    batch_build: Duration,
    parser_wait: Duration,
    duckdb_wait: Duration,
    peak_memory_mb: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct ImportPerformanceSnapshot {
    #[serde(default)]
    import_strategy: String,
    #[serde(default)]
    duckdb_xlsx_method: String,
    #[serde(default)]
    duckdb_xlsx_options: String,
    file_open_ms: u128,
    xlsx_open_ms: u128,
    worksheets_read_ms: u128,
    #[serde(default)]
    excel_workbook_inspection_ms: u128,
    #[serde(default)]
    excel_header_detection_ms: u128,
    #[serde(default)]
    excel_sheet_import_ms: u128,
    #[serde(default)]
    excel_total_import_ms: u128,
    #[serde(default)]
    csv_generation_ms: u128,
    #[serde(default)]
    batch_size: usize,
    #[serde(default)]
    batch_count: usize,
    #[serde(default)]
    batch_build_total_ms: u128,
    #[serde(default)]
    batch_build_avg_ms: u128,
    #[serde(default)]
    duckdb_arrow_ingestion_ms: u128,
    #[serde(default)]
    duckdb_arrow_ingestion_avg_ms: u128,
    #[serde(default)]
    pipeline_wait_parser_ms: u128,
    #[serde(default)]
    pipeline_wait_duckdb_ms: u128,
    #[serde(default)]
    peak_memory_mb: u64,
    cell_conversion_ms: u128,
    validation_ms: u128,
    data_preparation_ms: u128,
    duckdb_ms: u128,
    duckdb_table_cleanup_ms: u128,
    duckdb_table_creation_ms: u128,
    #[serde(default)]
    duckdb_xlsx_import_ms: u128,
    #[serde(default)]
    duckdb_copy_ms: u128,
    duckdb_appender_ms: u128,
    duckdb_flush_ms: u128,
    duckdb_commit_ms: u128,
    duckdb_final_queries_ms: u128,
    auxiliary_structures_ms: u128,
    frontend_events_ms: u128,
    total_ms: u128,
}

impl ImportPerformance {
    fn elapsed_ms(duration: Duration) -> u128 {
        duration.as_millis()
    }

    fn avg_ms(duration: Duration, count: usize) -> u128 {
        if count == 0 {
            0
        } else {
            duration.as_millis() / count as u128
        }
    }

    fn snapshot(
        &self,
        total: Duration,
        import_strategy: ImportStrategy,
    ) -> ImportPerformanceSnapshot {
        ImportPerformanceSnapshot {
            import_strategy: import_strategy.as_str().to_string(),
            duckdb_xlsx_method: import_strategy.duckdb_xlsx_method().to_string(),
            duckdb_xlsx_options: import_strategy.duckdb_xlsx_options().to_string(),
            file_open_ms: Self::elapsed_ms(self.file_open),
            xlsx_open_ms: Self::elapsed_ms(self.xlsx_open),
            worksheets_read_ms: Self::elapsed_ms(self.worksheets_read),
            excel_workbook_inspection_ms: Self::elapsed_ms(self.excel_workbook_inspection),
            excel_header_detection_ms: Self::elapsed_ms(self.excel_header_detection),
            excel_sheet_import_ms: Self::elapsed_ms(self.excel_sheet_import),
            excel_total_import_ms: Self::elapsed_ms(
                self.excel_workbook_inspection
                    + self.excel_header_detection
                    + self.excel_sheet_import,
            ),
            csv_generation_ms: Self::elapsed_ms(self.csv_generation),
            batch_size: self.batch_detail.batch_size,
            batch_count: self.batch_detail.batch_count,
            batch_build_total_ms: Self::elapsed_ms(self.batch_detail.batch_build),
            batch_build_avg_ms: Self::avg_ms(
                self.batch_detail.batch_build,
                self.batch_detail.batch_count,
            ),
            duckdb_arrow_ingestion_ms: Self::elapsed_ms(self.duckdb_detail.arrow_ingestion),
            duckdb_arrow_ingestion_avg_ms: Self::avg_ms(
                self.duckdb_detail.arrow_ingestion,
                self.batch_detail.batch_count,
            ),
            pipeline_wait_parser_ms: Self::elapsed_ms(self.batch_detail.parser_wait),
            pipeline_wait_duckdb_ms: Self::elapsed_ms(self.batch_detail.duckdb_wait),
            peak_memory_mb: self.batch_detail.peak_memory_mb,
            cell_conversion_ms: Self::elapsed_ms(self.cell_conversion),
            validation_ms: Self::elapsed_ms(self.validation),
            data_preparation_ms: Self::elapsed_ms(self.data_preparation),
            duckdb_ms: Self::elapsed_ms(self.duckdb),
            duckdb_table_cleanup_ms: Self::elapsed_ms(self.duckdb_detail.table_cleanup),
            duckdb_table_creation_ms: Self::elapsed_ms(self.duckdb_detail.table_creation),
            duckdb_xlsx_import_ms: Self::elapsed_ms(self.duckdb_detail.xlsx_import),
            duckdb_copy_ms: Self::elapsed_ms(self.duckdb_detail.copy),
            duckdb_appender_ms: Self::elapsed_ms(self.duckdb_detail.appender),
            duckdb_flush_ms: Self::elapsed_ms(self.duckdb_detail.flush),
            duckdb_commit_ms: Self::elapsed_ms(self.duckdb_detail.commit),
            duckdb_final_queries_ms: Self::elapsed_ms(self.duckdb_detail.final_queries),
            auxiliary_structures_ms: Self::elapsed_ms(self.auxiliary_structures),
            frontend_events_ms: Self::elapsed_ms(self.frontend_events),
            total_ms: Self::elapsed_ms(total),
        }
    }

    fn log_xlsx(
        &self,
        file_name: &str,
        sheet_name: &str,
        rows: usize,
        columns: usize,
        total: Duration,
        import_strategy: ImportStrategy,
    ) {
        let total_ms = Self::elapsed_ms(total);
        let xlsx_percent = if total_ms > 0 {
            Self::elapsed_ms(self.xlsx_open + self.worksheets_read) * 100 / total_ms
        } else {
            0
        };
        let duckdb_percent = if total_ms > 0 {
            Self::elapsed_ms(self.duckdb) * 100 / total_ms
        } else {
            0
        };
        let outros_percent = 100u128.saturating_sub(xlsx_percent + duckdb_percent);

        eprintln!(
            "IMPORT_PERFORMANCE\n\
arquivo: {file_name}\n\
planilha: {sheet_name}\n\
linhas: {rows}\n\
colunas: {columns}\n\
estrategia: {}\n\
duckdb_xlsx_method: {}\n\
duckdb_xlsx_options: {}\n\
abertura_arquivo_ms: {}\n\
leitura_descompactacao_xlsx_ms: {}\n\
leitura_planilhas_ms: {}\n\
excel_workbook_inspection_ms: {}\n\
excel_header_detection_ms: {}\n\
excel_sheet_import_ms: {}\n\
excel_total_import_ms: {}\n\
csv_generation_ms: {}\n\
batch_size: {}\n\
batch_count: {}\n\
batch_build_total_ms: {}\n\
batch_build_avg_ms: {}\n\
conversao_celulas_ms: {}\n\
validacao_ms: {}\n\
preparacao_dados_ms: {}\n\
duckdb_ms: {}\n\
duckdb_limpeza_tabela_ms: {}\n\
duckdb_criacao_tabela_ms: {}\n\
duckdb_xlsx_import_ms: {}\n\
duckdb_copy_ms: {}\n\
duckdb_arrow_ingestion_ms: {}\n\
duckdb_arrow_ingestion_avg_ms: {}\n\
duckdb_appender_ms: {}\n\
duckdb_flush_ms: {}\n\
duckdb_commit_ms: {}\n\
duckdb_consultas_finais_ms: {}\n\
duckdb_total_ms: {}\n\
estruturas_auxiliares_ms: {}\n\
frontend_events_ms: {}\n\
pipeline_wait_parser_ms: {}\n\
pipeline_wait_duckdb_ms: {}\n\
peak_memory_mb: {}\n\
total_ms: {}\n\
xlsx_percent: {xlsx_percent}%\n\
duckdb_percent: {duckdb_percent}%\n\
outros_percent: {outros_percent}%",
            import_strategy.as_str(),
            import_strategy.duckdb_xlsx_method(),
            import_strategy.duckdb_xlsx_options(),
            Self::elapsed_ms(self.file_open),
            Self::elapsed_ms(self.xlsx_open),
            Self::elapsed_ms(self.worksheets_read),
            Self::elapsed_ms(self.excel_workbook_inspection),
            Self::elapsed_ms(self.excel_header_detection),
            Self::elapsed_ms(self.excel_sheet_import),
            Self::elapsed_ms(
                self.excel_workbook_inspection
                    + self.excel_header_detection
                    + self.excel_sheet_import,
            ),
            Self::elapsed_ms(self.csv_generation),
            self.batch_detail.batch_size,
            self.batch_detail.batch_count,
            Self::elapsed_ms(self.batch_detail.batch_build),
            Self::avg_ms(self.batch_detail.batch_build, self.batch_detail.batch_count),
            Self::elapsed_ms(self.cell_conversion),
            Self::elapsed_ms(self.validation),
            Self::elapsed_ms(self.data_preparation),
            Self::elapsed_ms(self.duckdb),
            Self::elapsed_ms(self.duckdb_detail.table_cleanup),
            Self::elapsed_ms(self.duckdb_detail.table_creation),
            Self::elapsed_ms(self.duckdb_detail.xlsx_import),
            Self::elapsed_ms(self.duckdb_detail.copy),
            Self::elapsed_ms(self.duckdb_detail.arrow_ingestion),
            Self::avg_ms(
                self.duckdb_detail.arrow_ingestion,
                self.batch_detail.batch_count
            ),
            Self::elapsed_ms(self.duckdb_detail.appender),
            Self::elapsed_ms(self.duckdb_detail.flush),
            Self::elapsed_ms(self.duckdb_detail.commit),
            Self::elapsed_ms(self.duckdb_detail.final_queries),
            Self::elapsed_ms(self.duckdb),
            Self::elapsed_ms(self.auxiliary_structures),
            Self::elapsed_ms(self.frontend_events),
            Self::elapsed_ms(self.batch_detail.parser_wait),
            Self::elapsed_ms(self.batch_detail.duckdb_wait),
            self.batch_detail.peak_memory_mb,
            Self::elapsed_ms(total),
        );
    }
}

#[derive(Clone, Copy)]
enum ImportStrategy {
    Legacy,
    Appender,
    CsvKnownSchema,
    ArrowBatch,
    XlsxDirect,
}

impl ImportStrategy {
    fn as_str(self) -> &'static str {
        match self {
            ImportStrategy::Legacy => "legacy",
            ImportStrategy::Appender => "appender",
            ImportStrategy::CsvKnownSchema => "csv_known_schema",
            ImportStrategy::ArrowBatch => "arrow_batch",
            ImportStrategy::XlsxDirect => "xlsx_direct",
        }
    }

    fn duckdb_xlsx_method(self) -> &'static str {
        match self {
            ImportStrategy::XlsxDirect => "read_xlsx_create_table_as",
            _ => "",
        }
    }

    fn duckdb_xlsx_options(self) -> &'static str {
        match self {
            ImportStrategy::XlsxDirect => "header=true, all_varchar=true",
            _ => "",
        }
    }
}

fn xlsx_import_strategy() -> ImportStrategy {
    match std::env::var("VALTRON_XLSX_IMPORT_STRATEGY") {
        Ok(strategy) if strategy.eq_ignore_ascii_case("legacy") => ImportStrategy::Legacy,
        Ok(strategy) if strategy.eq_ignore_ascii_case("appender") => ImportStrategy::Appender,
        Ok(strategy) if strategy.eq_ignore_ascii_case("csv_known_schema") => {
            ImportStrategy::CsvKnownSchema
        }
        Ok(strategy) if strategy.eq_ignore_ascii_case("duckdb_csv") => {
            ImportStrategy::CsvKnownSchema
        }
        Ok(strategy) if strategy.eq_ignore_ascii_case("arrow_batch") => ImportStrategy::ArrowBatch,
        Ok(strategy) if strategy.eq_ignore_ascii_case("xlsx_direct") => ImportStrategy::XlsxDirect,
        Ok(strategy) if strategy.eq_ignore_ascii_case("duckdb_xlsx") => ImportStrategy::XlsxDirect,
        _ => ImportStrategy::XlsxDirect,
    }
}

#[derive(Serialize)]
struct ImportSummary {
    document_id: String,
    file_name: String,
    sheet_name: String,
    columns: Vec<String>,
    row_count: usize,
    imported_at: String,
    import_duration_ms: Option<u128>,
    import_performance: Option<ImportPerformanceSnapshot>,
}

#[derive(Clone, Serialize)]
struct ExcelSheetInfo {
    name: String,
    index: usize,
    visibility: String,
}

#[derive(Serialize)]
struct ExcelWorkbookInspection {
    file_name: String,
    sheets: Vec<ExcelSheetInfo>,
    inspection_duration_ms: u128,
}

#[derive(Clone)]
struct ExcelSheetMetadata {
    public: ExcelSheetInfo,
    relationship_id: Option<String>,
}

#[derive(Clone, Debug)]
struct WorkbookRelationship {
    id: String,
    relationship_type: String,
    target: String,
}

#[derive(Clone, Debug)]
struct HeaderDetection {
    header_row: u32,
    column_count: usize,
    rows_scanned: usize,
    fallback_used: bool,
}

#[derive(Clone, Debug)]
struct HeaderScanRow {
    row_number: u32,
    cells: HashMap<usize, String>,
}

#[derive(Clone, Debug)]
enum ScannedCellValue {
    Literal(String),
    Shared(usize),
}

#[derive(Clone, Debug)]
struct RawHeaderScanRow {
    row_number: u32,
    cells: HashMap<usize, ScannedCellValue>,
}

#[derive(Serialize)]
struct DocumentInfo {
    id: String,
    workspace_id: String,
    file_name: String,
    sheet_name: String,
    table_name: String,
    row_count: usize,
    column_count: usize,
    imported_at: String,
    import_duration_ms: Option<u128>,
    import_performance: Option<ImportPerformanceSnapshot>,
}

#[derive(Clone)]
struct DocumentRecord {
    id: String,
    workspace_id: String,
    file_name: String,
    table_name: String,
}

#[derive(Serialize)]
struct SqlSourceInfo {
    id: String,
    name: String,
    table_name: String,
    columns: Vec<String>,
    column_types: HashMap<String, String>,
}

#[derive(Serialize)]
struct WorkspaceInfo {
    id: String,
    name: String,
    created_at: String,
    document_count: usize,
}

#[derive(Serialize)]
struct TablePage {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total_rows: usize,
    offset: usize,
    limit: usize,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    filters: Vec<ColumnFilter>,
    stats: TableStats,
}

#[derive(Serialize)]
struct GridPerformance {
    query_duckdb_ms: u128,
    rust_processing_ms: u128,
    total_ms: u128,
    rows: usize,
    offset: usize,
    limit: usize,
}

#[derive(Serialize)]
struct TableWindow {
    columns: Vec<String>,
    column_types: HashMap<String, String>,
    rows: Vec<Vec<Option<String>>>,
    row_ids: Vec<Option<i64>>,
    total_rows: usize,
    offset: usize,
    limit: usize,
    has_more: bool,
    next_offset: Option<usize>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    filters: Vec<ColumnFilter>,
    stats: TableStats,
    performance: GridPerformance,
}

#[derive(Serialize)]
struct CellUpdateResult {
    row_id: i64,
    column: String,
    value: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ColumnFilter {
    column: String,
    #[serde(default = "default_filter_operator")]
    operator: String,
    value: String,
    #[serde(default)]
    rule_id: Option<String>,
}

fn default_filter_operator() -> String {
    "contains".to_string()
}

#[derive(Clone, Serialize)]
struct ColumnProfile {
    column: String,
    physical_type: String,
    inferred_type: String,
    total_count: usize,
    filled_count: usize,
    empty_count: usize,
    empty_percentage: f64,
    distinct_count: usize,
    duplicate_count: usize,
    text_stats: Option<TextStats>,
    numeric_stats: Option<NumericStats>,
    date_stats: Option<DateStats>,
    boolean_stats: Option<Vec<BooleanStat>>,
    top_values: Vec<ValueFrequency>,
    distribution: Vec<DistributionBucket>,
    performance: ColumnProfilePerformance,
}

#[derive(Clone, Serialize)]
struct TextStats {
    min_length: Option<f64>,
    avg_length: Option<f64>,
    max_length: Option<f64>,
}

#[derive(Clone, Serialize)]
struct NumericStats {
    min: Option<f64>,
    max: Option<f64>,
    avg: Option<f64>,
    median: Option<f64>,
    stddev: Option<f64>,
}

#[derive(Clone, Serialize)]
struct DateStats {
    min: Option<String>,
    max: Option<String>,
    predominant_format: Option<String>,
    example_original: Option<String>,
    example_interpreted: Option<String>,
}

#[derive(Clone, Serialize)]
struct BooleanStat {
    label: String,
    count: usize,
    percentage: f64,
}

#[derive(Clone, Serialize)]
struct ValueFrequency {
    value: String,
    count: usize,
}

#[derive(Clone, Serialize)]
struct DistributionBucket {
    bucket: usize,
    min: f64,
    max: f64,
    count: usize,
}

#[derive(Clone, Serialize)]
struct ColumnProfilePerformance {
    duckdb_ms: u128,
    processing_ms: u128,
    total_ms: u128,
    cache_hit: bool,
}

#[derive(Clone)]
struct InferredColumn {
    inferred_type: String,
    date_source: Option<String>,
}

#[derive(Serialize)]
struct ColumnQuality {
    column: String,
    empty_count: usize,
}

#[derive(Serialize)]
struct TableStats {
    column_count: usize,
    columns_with_empty: usize,
    empty_cells: usize,
    quality: Vec<ColumnQuality>,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Nao foi possivel localizar a pasta de dados: {error}"))?;

    fs::create_dir_all(&dir)
        .map_err(|error| format!("Nao foi possivel criar a pasta de dados: {error}"))?;

    Ok(dir.join("valtron.duckdb"))
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app)?)
        .map_err(|error| format!("Nao foi possivel abrir o DuckDB: {error}"))?;
    init_database(&connection)?;
    Ok(connection)
}

fn init_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel inicializar os workspaces: {error}"))?;

    ensure_default_workspace(connection)?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT '{}',
                    file_name TEXT NOT NULL,
                    sheet_name TEXT NOT NULL,
                    table_name TEXT NOT NULL UNIQUE,
                    row_count BIGINT NOT NULL,
                    column_count BIGINT NOT NULL,
                    imported_at TEXT NOT NULL,
                    import_duration_ms BIGINT,
                    import_performance_json TEXT,
                    source_type TEXT,
                    source_file_name TEXT,
                    source_sheet_name TEXT
                )",
                quoted_identifier(DOCUMENTS_TABLE),
                DEFAULT_WORKSPACE_ID
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel inicializar os documentos: {error}"))?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    source_document_id TEXT,
                    result_document_id TEXT NOT NULL,
                    sql TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )",
                quoted_identifier(SQL_LINEAGE_TABLE)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel inicializar lineage SQL: {error}"))?;

    ensure_document_workspace_column(connection)?;
    ensure_document_import_duration_column(connection)?;
    ensure_document_import_performance_column(connection)?;
    ensure_document_source_columns(connection)?;
    assign_default_workspace_to_documents(connection)?;
    quality::init_database(connection)?;
    transformations::init_database(connection)?;

    Ok(())
}

fn ensure_default_workspace(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "INSERT OR IGNORE INTO {} (id, name, created_at) VALUES (?, ?, ?)",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            params![DEFAULT_WORKSPACE_ID, "Principal", "0"],
        )
        .map_err(|error| format!("Nao foi possivel criar o workspace padrao: {error}"))?;

    Ok(())
}

fn column_exists(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT COUNT(*)
             FROM information_schema.columns
             WHERE table_name = ? AND column_name = ?",
            params![table_name, column_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(|error| format!("Nao foi possivel verificar a estrutura do banco: {error}"))
}

fn ensure_document_workspace_column(connection: &Connection) -> Result<(), String> {
    if column_exists(connection, DOCUMENTS_TABLE, "workspace_id")? {
        return Ok(());
    }

    connection
        .execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN workspace_id TEXT DEFAULT '{}'",
                quoted_identifier(DOCUMENTS_TABLE),
                DEFAULT_WORKSPACE_ID
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel migrar documentos para workspaces: {error}"))?;

    Ok(())
}

fn ensure_document_import_duration_column(connection: &Connection) -> Result<(), String> {
    if column_exists(connection, DOCUMENTS_TABLE, "import_duration_ms")? {
        return Ok(());
    }

    connection
        .execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN import_duration_ms BIGINT",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel migrar duracao de importacao: {error}"))?;

    Ok(())
}

fn ensure_document_import_performance_column(connection: &Connection) -> Result<(), String> {
    if column_exists(connection, DOCUMENTS_TABLE, "import_performance_json")? {
        return Ok(());
    }

    connection
        .execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN import_performance_json TEXT",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel migrar metricas de importacao: {error}"))?;

    Ok(())
}

fn ensure_document_text_column(
    connection: &Connection,
    column_name: &str,
    error_context: &str,
) -> Result<(), String> {
    if column_exists(connection, DOCUMENTS_TABLE, column_name)? {
        return Ok(());
    }

    connection
        .execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN {} TEXT",
                quoted_identifier(DOCUMENTS_TABLE),
                quoted_identifier(column_name)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel migrar {error_context}: {error}"))?;

    Ok(())
}

fn ensure_document_source_columns(connection: &Connection) -> Result<(), String> {
    ensure_document_text_column(connection, "source_type", "tipo da origem dos documentos")?;
    ensure_document_text_column(
        connection,
        "source_file_name",
        "arquivo de origem dos documentos",
    )?;
    ensure_document_text_column(
        connection,
        "source_sheet_name",
        "planilha de origem dos documentos",
    )?;

    Ok(())
}

fn assign_default_workspace_to_documents(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "UPDATE {}
                 SET workspace_id = ?
                 WHERE workspace_id IS NULL OR TRIM(workspace_id) = ''",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![DEFAULT_WORKSPACE_ID],
        )
        .map_err(|error| {
            format!("Nao foi possivel associar documentos ao workspace padrao: {error}")
        })?;

    Ok(())
}

fn quoted_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn table_sql(table_name: &str) -> String {
    quoted_identifier(table_name)
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());

    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }

    escaped
}

fn xlsx_column_name(mut index: usize) -> String {
    let mut name = String::new();

    loop {
        let remainder = index % 26;
        name.insert(0, (b'A' + remainder as u8) as char);

        if index < 26 {
            break;
        }

        index = (index / 26) - 1;
    }

    name
}

fn temp_import_path(app: &AppHandle, document_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Nao foi possivel localizar a pasta temporaria: {error}"))?
        .join("imports");

    fs::create_dir_all(&dir)
        .map_err(|error| format!("Nao foi possivel criar a pasta temporaria: {error}"))?;

    Ok(dir.join(format!("{document_id}.csv")))
}

fn temp_xlsx_compatibility_path(app: &AppHandle, document_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Nao foi possivel localizar a pasta temporaria: {error}"))?
        .join("imports");

    fs::create_dir_all(&dir)
        .map_err(|error| format!("Nao foi possivel criar a pasta temporaria: {error}"))?;

    Ok(dir.join(format!("{document_id}_relationships.xlsx")))
}

struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        fs::remove_file(&self.path).ok();
    }
}

fn write_csv_record(writer: &mut BufWriter<fs::File>, values: &[String]) -> Result<(), String> {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            writer
                .write_all(b",")
                .map_err(|error| format!("Nao foi possivel escrever o CSV temporario: {error}"))?;
        }

        writer
            .write_all(b"\"")
            .map_err(|error| format!("Nao foi possivel escrever o CSV temporario: {error}"))?;

        for byte in value.bytes() {
            if byte == b'"' {
                writer.write_all(b"\"\"").map_err(|error| {
                    format!("Nao foi possivel escapar o CSV temporario: {error}")
                })?;
            } else {
                writer.write_all(&[byte]).map_err(|error| {
                    format!("Nao foi possivel escrever o CSV temporario: {error}")
                })?;
            }
        }

        writer
            .write_all(b"\"")
            .map_err(|error| format!("Nao foi possivel escrever o CSV temporario: {error}"))?;
    }

    writer.write_all(b"\n").map_err(|error| {
        format!("Nao foi possivel finalizar a linha do CSV temporario: {error}")
    })?;

    Ok(())
}

struct XlsxArrowBatch {
    columns: Vec<Vec<Option<String>>>,
    rows: usize,
    capacity: usize,
}

impl XlsxArrowBatch {
    fn new(width: usize, capacity: usize) -> Self {
        let columns = (0..width)
            .map(|_| Vec::with_capacity(capacity))
            .collect::<Vec<_>>();

        Self {
            columns,
            rows: 0,
            capacity,
        }
    }

    fn push_row(&mut self, values: &mut [String]) {
        for (column_index, column) in self.columns.iter_mut().enumerate() {
            column.push(Some(std::mem::take(&mut values[column_index])));
        }

        self.rows += 1;
    }

    fn is_empty(&self) -> bool {
        self.rows == 0
    }

    fn is_full(&self) -> bool {
        self.rows >= self.capacity
    }

    fn into_record_batch(self, schema: SchemaRef) -> Result<RecordBatch, String> {
        let arrays = self
            .columns
            .into_iter()
            .map(|column| Arc::new(StringArray::from(column)) as ArrayRef)
            .collect::<Vec<_>>();

        RecordBatch::try_new(schema, arrays)
            .map_err(|error| format!("Nao foi possivel montar o batch Arrow: {error}"))
    }
}

fn arrow_schema_for_columns(columns: &[String]) -> SchemaRef {
    Arc::new(Schema::new(
        columns
            .iter()
            .map(|column| Field::new(column, DataType::Utf8, true))
            .collect::<Vec<_>>(),
    ))
}

fn configured_xlsx_batch_size() -> usize {
    std::env::var("VALTRON_XLSX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(50_000)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn peak_memory_mb() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };

    if rc != 0 {
        return 0;
    }

    let max_rss = unsafe { usage.assume_init().ru_maxrss };

    #[cfg(target_os = "macos")]
    {
        (max_rss as u64) / 1024 / 1024
    }

    #[cfg(target_os = "linux")]
    {
        (max_rss as u64) / 1024
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peak_memory_mb() -> u64 {
    0
}

fn now_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("Relogio do sistema invalido: {error}"))
}

fn new_document_id() -> Result<String, String> {
    Ok(format!("doc_{}", now_millis()?))
}

fn new_workspace_id() -> Result<String, String> {
    Ok(format!("workspace_{}", now_millis()?))
}

fn workspace_or_default(workspace_id: Option<String>) -> String {
    workspace_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string())
}

fn ensure_workspace_exists(connection: &Connection, workspace_id: &str) -> Result<(), String> {
    let exists = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE id = ?",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            params![workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel verificar o workspace: {error}"))?
        > 0;

    if !exists {
        return Err("Workspace nao encontrado.".to_string());
    }

    Ok(())
}

fn normalized_headers(raw_headers: &[String], width: usize) -> Vec<String> {
    let mut headers = Vec::with_capacity(width);

    for index in 0..width {
        let base = raw_headers
            .get(index)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("coluna");

        let mut candidate = base.to_string();
        let mut suffix = 2;

        while headers.iter().any(|header| header == &candidate) {
            candidate = format!("{base}_{suffix}");
            suffix += 1;
        }

        headers.push(candidate);
    }

    headers
}

fn drop_table(connection: &Connection, table_name: &str) -> Result<(), String> {
    connection
        .execute(
            &format!("DROP TABLE IF EXISTS {}", quoted_identifier(table_name)),
            [],
        )
        .map_err(|error| format!("Nao foi possivel limpar a tabela anterior: {error}"))?;

    Ok(())
}

fn create_table_without_drop(
    connection: &Connection,
    table_name: &str,
    columns: &[String],
) -> Result<(), String> {
    let column_sql = columns
        .iter()
        .map(|column| format!("{} TEXT", quoted_identifier(column)))
        .collect::<Vec<_>>()
        .join(", ");

    connection
        .execute(
            &format!(
                "CREATE TABLE {} ({column_sql})",
                quoted_identifier(table_name)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel criar a tabela no DuckDB: {error}"))?;

    Ok(())
}

fn try_import_xlsx_with_duckdb_excel(
    connection: &Connection,
    file_path: &PathBuf,
    table_name: &str,
    columns: &[String],
) -> Result<(), String> {
    connection
        .execute("LOAD excel", [])
        .map_err(|error| format!("Extensao excel indisponivel no DuckDB: {error}"))?;

    drop_table(connection, table_name)?;
    create_table_without_drop(connection, table_name, columns)?;

    let xlsx_path = sql_string_literal(&file_path.to_string_lossy());
    let copy_sql = format!(
        "COPY {} FROM {xlsx_path} WITH (FORMAT xlsx, HEADER true)",
        quoted_identifier(table_name)
    );

    connection
        .execute(&copy_sql, [])
        .map_err(|error| format!("DuckDB nao conseguiu ler o XLSX diretamente: {error}"))?;

    Ok(())
}

fn is_duckdb_xlsx_relationship_id_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("no sheets found in xlsx file")
        && normalized.contains("is the file corrupt")
}

fn try_import_xlsx_direct_without_preopen(
    connection: &Connection,
    file_path: &PathBuf,
    table_name: &str,
    sheet_name: Option<&str>,
    range: Option<&str>,
) -> Result<(), String> {
    connection
        .execute("LOAD excel", [])
        .map_err(|error| format!("Extensao excel indisponivel no DuckDB: {error}"))?;

    drop_table(connection, table_name)?;

    let xlsx_path = sql_string_literal(&file_path.to_string_lossy());
    let sheet_sql = sheet_name
        .map(|name| format!(",\n            sheet = {}", sql_string_literal(name)))
        .unwrap_or_default();
    let range_sql = range
        .map(|value| format!(",\n            range = {}", sql_string_literal(value)))
        .unwrap_or_default();
    let create_sql = format!(
        "CREATE TABLE {} AS
         SELECT *
         FROM read_xlsx(
            {xlsx_path},
            header = true,
            all_varchar = true,
            stop_at_empty = true
            {sheet_sql}
            {range_sql}
         )",
        quoted_identifier(table_name)
    );

    connection.execute(&create_sql, []).map_err(|error| {
        format!("DuckDB nao conseguiu criar a tabela diretamente do XLSX: {error}")
    })?;

    Ok(())
}

fn try_import_xlsx_direct_with_relationship_fallback(
    connection: &Connection,
    file_path: &PathBuf,
    table_name: &str,
    sheet_name: Option<&str>,
    range: Option<&str>,
    temp_path: &PathBuf,
) -> Result<(), String> {
    eprintln!("[xlsx-import] tentando read_xlsx no arquivo original");
    match try_import_xlsx_direct_without_preopen(
        connection, file_path, table_name, sheet_name, range,
    ) {
        Ok(()) => {
            eprintln!("[xlsx-import] importacao xlsx concluida no arquivo original");
            Ok(())
        }
        Err(original_error) => {
            eprintln!("[xlsx-import] read_xlsx falhou no arquivo original: {original_error}");

            if !is_duckdb_xlsx_relationship_id_error(&original_error) {
                return Err(original_error);
            }

            if !xlsx_needs_relationship_id_normalization(file_path)? {
                return Err(original_error);
            }

            eprintln!("[xlsx-import] erro identificado como incompatibilidade de relationship IDs");
            let temp_file = TempFileGuard::new(temp_path.clone());
            normalize_xlsx_workbook_relationship_ids(file_path, temp_file.path())?;
            eprintln!("[xlsx-import] tentando read_xlsx novamente no arquivo temporario");

            match try_import_xlsx_direct_without_preopen(
                connection,
                temp_file.path(),
                table_name,
                sheet_name,
                range,
            ) {
                Ok(()) => {
                    eprintln!("[xlsx-import] importacao xlsx concluida apos normalizacao");
                    Ok(())
                }
                Err(fallback_error) => {
                    eprintln!(
                        "[xlsx-import] fallback tambem falhou. erro_original={original_error}; erro_fallback={fallback_error}"
                    );
                    Err(format!(
                        "Nao foi possivel importar a planilha, mesmo apos aplicar o tratamento de compatibilidade XLSX.\n\nErro original: {original_error}\n\nErro apos normalizacao: {fallback_error}"
                    ))
                }
            }
        }
    }
}

fn inspect_excel_workbook_metadata_internal(
    file_path: &PathBuf,
) -> Result<Vec<ExcelSheetMetadata>, String> {
    let file = fs::File::open(file_path)
        .map_err(|error| format!("Nao foi possivel abrir o arquivo Excel: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let mut workbook_xml = String::new();
    archive
        .by_name("xl/workbook.xml")
        .map_err(|error| format!("Nao foi possivel ler os metadados do workbook: {error}"))?
        .read_to_string(&mut workbook_xml)
        .map_err(|error| format!("Nao foi possivel carregar os metadados do workbook: {error}"))?;

    let mut reader = XmlReader::from_str(&workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer).map_err(|error| {
            format!("Nao foi possivel interpretar os metadados do workbook: {error}")
        })? {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"sheet" =>
            {
                let mut name = None;
                let mut visibility = "visible".to_string();
                let mut relationship_id = None;

                for attribute in element.attributes().with_checks(false).flatten() {
                    if attribute.key.as_ref() == b"name" {
                        name = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    } else if attribute.key.as_ref() == b"state" {
                        visibility = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .map(|value| value.into_owned())
                            .unwrap_or_else(|_| "visible".to_string());
                    } else if attribute.key.as_ref() == b"r:id"
                        || attribute.key.as_ref().ends_with(b":id")
                        || attribute.key.as_ref() == b"id"
                    {
                        relationship_id = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    }
                }

                if let Some(name) = name {
                    sheets.push(ExcelSheetMetadata {
                        public: ExcelSheetInfo {
                            name,
                            index: sheets.len(),
                            visibility,
                        },
                        relationship_id,
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    if sheets.is_empty() {
        return Err("O arquivo nao possui planilhas importaveis.".to_string());
    }

    Ok(sheets)
}

fn inspect_excel_workbook_metadata(file_path: &PathBuf) -> Result<Vec<ExcelSheetInfo>, String> {
    Ok(inspect_excel_workbook_metadata_internal(file_path)?
        .into_iter()
        .map(|sheet| sheet.public)
        .collect())
}

fn first_xlsx_sheet_name_from_workbook_xml(file_path: &PathBuf) -> Result<Option<String>, String> {
    Ok(inspect_excel_workbook_metadata(file_path)?
        .into_iter()
        .next()
        .map(|sheet| sheet.name))
}

fn parse_workbook_relationships(
    relationships_xml: &str,
) -> Result<Vec<WorkbookRelationship>, String> {
    let mut reader = XmlReader::from_str(relationships_xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut relationships = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Nao foi possivel interpretar relacionamentos: {error}"))?
        {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"Relationship" =>
            {
                let mut id = None;
                let mut relationship_type = None;
                let mut target = None;

                for attribute in element.attributes().with_checks(false).flatten() {
                    if attribute.key.as_ref() == b"Id" {
                        id = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    } else if attribute.key.as_ref() == b"Type" {
                        relationship_type = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    } else if attribute.key.as_ref() == b"Target" {
                        target = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    }
                }

                if let (Some(id), Some(relationship_type), Some(target)) =
                    (id, relationship_type, target)
                {
                    relationships.push(WorkbookRelationship {
                        id,
                        relationship_type,
                        target,
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    Ok(relationships)
}

fn read_xlsx_zip_text(file_path: &PathBuf, entry_name: &str) -> Result<String, String> {
    let file = fs::File::open(file_path)
        .map_err(|error| format!("Nao foi possivel abrir o arquivo Excel: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let mut content = String::new();
    archive
        .by_name(entry_name)
        .map_err(|error| format!("Nao foi possivel ler {entry_name}: {error}"))?
        .read_to_string(&mut content)
        .map_err(|error| format!("Nao foi possivel carregar {entry_name}: {error}"))?;

    Ok(content)
}

fn is_worksheet_relationship(relationship_type: &str) -> bool {
    relationship_type.ends_with("/worksheet")
}

fn relationship_points_to_worksheet(relationship: &WorkbookRelationship) -> bool {
    is_worksheet_relationship(&relationship.relationship_type)
        && normalize_workbook_target(&relationship.target).starts_with("xl/worksheets/")
}

fn xlsx_needs_relationship_id_normalization(file_path: &PathBuf) -> Result<bool, String> {
    let sheets = inspect_excel_workbook_metadata_internal(file_path)?;
    let relationships_xml = read_xlsx_zip_text(file_path, "xl/_rels/workbook.xml.rels")?;
    let relationships = parse_workbook_relationships(&relationships_xml)?;

    for (index, sheet) in sheets.iter().enumerate() {
        let relationship_id = sheet.relationship_id.as_deref().ok_or_else(|| {
            format!(
                "A planilha '{}' nao possui relacionamento interno.",
                sheet.public.name
            )
        })?;
        let relationship = relationships
            .iter()
            .find(|relationship| relationship.id == relationship_id)
            .ok_or_else(|| {
                format!(
                    "A planilha '{}' aponta para um relacionamento inexistente.",
                    sheet.public.name
                )
            })?;

        if !relationship_points_to_worksheet(relationship) {
            return Err(format!(
                "A planilha '{}' aponta para um relacionamento que nao e worksheet.",
                sheet.public.name
            ));
        }

        if relationship_id != format!("rId{}", index + 1) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn next_free_relationship_id(used_ids: &HashSet<String>) -> String {
    let mut index = 1usize;

    loop {
        let candidate = format!("rId{index}");

        if !used_ids.contains(&candidate) {
            return candidate;
        }

        index += 1;
    }
}

fn replace_relationship_attribute(
    xml: &mut String,
    attribute_name: &str,
    old_id: &str,
    new_id: &str,
) {
    if old_id == new_id {
        return;
    }

    *xml = xml.replace(
        &format!(r#"{attribute_name}="{old_id}""#),
        &format!(r#"{attribute_name}="{new_id}""#),
    );
}

fn normalized_workbook_relationship_xml(
    workbook_xml: &str,
    relationships_xml: &str,
    sheets: &[ExcelSheetMetadata],
    relationships: &[WorkbookRelationship],
) -> Result<Option<(String, String)>, String> {
    let mut worksheet_old_ids = Vec::with_capacity(sheets.len());
    let mut worksheet_old_id_set = HashSet::new();

    for sheet in sheets {
        let relationship_id = sheet.relationship_id.as_deref().ok_or_else(|| {
            format!(
                "A planilha '{}' nao possui relacionamento interno.",
                sheet.public.name
            )
        })?;
        let relationship = relationships
            .iter()
            .find(|relationship| relationship.id == relationship_id)
            .ok_or_else(|| {
                format!(
                    "A planilha '{}' aponta para um relacionamento inexistente.",
                    sheet.public.name
                )
            })?;

        if !relationship_points_to_worksheet(relationship) {
            return Err(format!(
                "A planilha '{}' aponta para um relacionamento que nao e worksheet.",
                sheet.public.name
            ));
        }

        worksheet_old_id_set.insert(relationship_id.to_string());
        worksheet_old_ids.push(relationship_id.to_string());
    }

    let reserved_worksheet_ids = (1..=worksheet_old_ids.len())
        .map(|index| format!("rId{index}"))
        .collect::<HashSet<_>>();
    let mut id_mapping = HashMap::new();
    let mut used_ids = HashSet::new();

    for (index, old_id) in worksheet_old_ids.iter().enumerate() {
        let new_id = format!("rId{}", index + 1);
        id_mapping.insert(old_id.clone(), new_id.clone());
        used_ids.insert(new_id);
    }

    for relationship in relationships {
        if worksheet_old_id_set.contains(&relationship.id) {
            continue;
        }

        let new_id = if reserved_worksheet_ids.contains(&relationship.id)
            || used_ids.contains(&relationship.id)
        {
            next_free_relationship_id(&used_ids)
        } else {
            relationship.id.clone()
        };

        used_ids.insert(new_id.clone());
        id_mapping.insert(relationship.id.clone(), new_id);
    }

    if id_mapping.iter().all(|(old_id, new_id)| old_id == new_id) {
        return Ok(None);
    }

    let mut normalized_workbook_xml = workbook_xml.to_string();
    let mut normalized_relationships_xml = relationships_xml.to_string();

    for old_id in &worksheet_old_ids {
        let new_id = id_mapping
            .get(old_id)
            .ok_or_else(|| "Mapeamento de relationship incompleto.".to_string())?;
        replace_relationship_attribute(&mut normalized_workbook_xml, "r:id", old_id, new_id);
    }

    for relationship in relationships {
        let new_id = id_mapping
            .get(&relationship.id)
            .ok_or_else(|| "Mapeamento de relationship incompleto.".to_string())?;
        replace_relationship_attribute(
            &mut normalized_relationships_xml,
            "Id",
            &relationship.id,
            new_id,
        );
    }

    Ok(Some((
        normalized_workbook_xml,
        normalized_relationships_xml,
    )))
}

fn normalize_xlsx_workbook_relationship_ids(
    source_path: &PathBuf,
    destination_path: &PathBuf,
) -> Result<(), String> {
    eprintln!("[xlsx-import] criando copia temporaria com relationships normalizados");
    let workbook_xml = read_xlsx_zip_text(source_path, "xl/workbook.xml")?;
    let relationships_xml = read_xlsx_zip_text(source_path, "xl/_rels/workbook.xml.rels")?;
    let sheets = inspect_excel_workbook_metadata_internal(source_path)?;
    let relationships = parse_workbook_relationships(&relationships_xml)?;
    let (normalized_workbook_xml, normalized_relationships_xml) =
        normalized_workbook_relationship_xml(
            &workbook_xml,
            &relationships_xml,
            &sheets,
            &relationships,
        )?
        .ok_or_else(|| "Nenhuma normalizacao de relationship ID era aplicavel.".to_string())?;

    let source_file = fs::File::open(source_path)
        .map_err(|error| format!("Nao foi possivel abrir o XLSX original: {error}"))?;
    let mut source_archive =
        ZipArchive::new(source_file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let destination_file = fs::File::create(destination_path)
        .map_err(|error| format!("Nao foi possivel criar o XLSX temporario: {error}"))?;
    let mut destination_archive = ZipWriter::new(destination_file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for index in 0..source_archive.len() {
        let mut source_entry = source_archive
            .by_index(index)
            .map_err(|error| format!("Nao foi possivel ler entrada do XLSX: {error}"))?;
        let entry_name = source_entry.name().to_string();

        if source_entry.is_dir() {
            destination_archive
                .add_directory(&entry_name, options)
                .map_err(|error| {
                    format!("Nao foi possivel gravar diretorio no XLSX temporario: {error}")
                })?;
            continue;
        }

        destination_archive
            .start_file(&entry_name, options)
            .map_err(|error| {
                format!("Nao foi possivel gravar entrada no XLSX temporario: {error}")
            })?;

        if entry_name == "xl/workbook.xml" {
            destination_archive
                .write_all(normalized_workbook_xml.as_bytes())
                .map_err(|error| {
                    format!("Nao foi possivel gravar workbook normalizado: {error}")
                })?;
        } else if entry_name == "xl/_rels/workbook.xml.rels" {
            destination_archive
                .write_all(normalized_relationships_xml.as_bytes())
                .map_err(|error| {
                    format!("Nao foi possivel gravar relationships normalizados: {error}")
                })?;
        } else {
            std::io::copy(&mut source_entry, &mut destination_archive)
                .map_err(|error| format!("Nao foi possivel copiar entrada do XLSX: {error}"))?;
        }
    }

    destination_archive
        .finish()
        .map_err(|error| format!("Nao foi possivel finalizar o XLSX temporario: {error}"))?;

    Ok(())
}

fn normalize_workbook_target(target: &str) -> String {
    let target = target.trim_start_matches('/');

    if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    }
}

fn worksheet_xml_path(file_path: &PathBuf, sheet_name: &str) -> Result<String, String> {
    let sheets = inspect_excel_workbook_metadata_internal(file_path)?;
    let sheet = sheets
        .iter()
        .find(|sheet| sheet.public.name == sheet_name)
        .ok_or_else(|| format!("A planilha '{sheet_name}' nao existe no arquivo."))?;
    let relationship_id = sheet
        .relationship_id
        .as_deref()
        .ok_or_else(|| format!("A planilha '{sheet_name}' nao possui relacionamento interno."))?;
    let file = fs::File::open(file_path)
        .map_err(|error| format!("Nao foi possivel abrir o arquivo Excel: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let mut relationships_xml = String::new();
    archive
        .by_name("xl/_rels/workbook.xml.rels")
        .map_err(|error| format!("Nao foi possivel ler relacionamentos do workbook: {error}"))?
        .read_to_string(&mut relationships_xml)
        .map_err(|error| {
            format!("Nao foi possivel carregar relacionamentos do workbook: {error}")
        })?;

    let mut reader = XmlReader::from_str(&relationships_xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Nao foi possivel interpretar relacionamentos: {error}"))?
        {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"Relationship" =>
            {
                let mut id = None;
                let mut target = None;

                for attribute in element.attributes().with_checks(false).flatten() {
                    if attribute.key.as_ref() == b"Id" {
                        id = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    } else if attribute.key.as_ref() == b"Target" {
                        target = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    }
                }

                if id.as_deref() == Some(relationship_id) {
                    return target
                        .map(|target| normalize_workbook_target(&target))
                        .ok_or_else(|| {
                            format!("A planilha '{sheet_name}' nao possui alvo interno.")
                        });
                }
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    Err(format!(
        "Nao foi possivel localizar o XML interno da planilha '{sheet_name}'."
    ))
}

fn parse_xlsx_cell_reference(reference: &str) -> Option<(u32, usize)> {
    let mut column = 0usize;
    let mut row = 0u32;
    let mut seen_digit = false;

    for byte in reference.bytes() {
        if byte.is_ascii_alphabetic() && !seen_digit {
            column = column * 26 + (byte.to_ascii_uppercase() - b'A' + 1) as usize;
        } else if byte.is_ascii_digit() {
            seen_digit = true;
            row = row * 10 + (byte - b'0') as u32;
        }
    }

    if column == 0 || row == 0 {
        None
    } else {
        Some((row, column - 1))
    }
}

fn decode_xml_text(text: quick_xml::events::BytesText<'_>) -> String {
    text.decode()
        .map(|value| value.into_owned())
        .unwrap_or_default()
}

fn read_shared_strings_subset(
    file_path: &PathBuf,
    required_indices: &HashSet<usize>,
) -> Result<HashMap<usize, String>, String> {
    if required_indices.is_empty() {
        return Ok(HashMap::new());
    }

    let file = fs::File::open(file_path)
        .map_err(|error| format!("Nao foi possivel abrir o arquivo Excel: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let Ok(mut shared_strings_file) = archive.by_name("xl/sharedStrings.xml") else {
        return Ok(HashMap::new());
    };
    let max_required = required_indices.iter().copied().max().unwrap_or(0);
    let mut reader = XmlReader::from_reader(BufReader::new(&mut shared_strings_file));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_index = 0usize;
    let mut in_shared_item = false;
    let mut in_text = false;
    let mut current_text = String::new();
    let mut values = HashMap::new();

    loop {
        match reader.read_event_into(&mut buffer).map_err(|error| {
            format!("Nao foi possivel interpretar strings compartilhadas: {error}")
        })? {
            Event::Start(element) if element.local_name().as_ref() == b"si" => {
                in_shared_item = true;
                current_text.clear();
            }
            Event::End(element) if element.local_name().as_ref() == b"si" => {
                if required_indices.contains(&current_index) {
                    values.insert(current_index, current_text.clone());
                }
                if current_index >= max_required && values.len() == required_indices.len() {
                    break;
                }
                current_index += 1;
                in_shared_item = false;
                in_text = false;
            }
            Event::Start(element) if in_shared_item && element.local_name().as_ref() == b"t" => {
                in_text = true;
            }
            Event::End(element) if element.local_name().as_ref() == b"t" => {
                in_text = false;
            }
            Event::Text(text) if in_shared_item && in_text => {
                current_text.push_str(&decode_xml_text(text));
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    Ok(values)
}

fn scan_sheet_header_rows(
    file_path: &PathBuf,
    sheet_name: &str,
) -> Result<Vec<HeaderScanRow>, String> {
    let worksheet_path = worksheet_xml_path(file_path, sheet_name)?;
    let file = fs::File::open(file_path)
        .map_err(|error| format!("Nao foi possivel abrir o arquivo Excel: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo Excel invalido: {error}"))?;
    let mut worksheet_file = archive
        .by_name(&worksheet_path)
        .map_err(|error| format!("Nao foi possivel ler a planilha '{sheet_name}': {error}"))?;

    let mut reader = XmlReader::from_reader(BufReader::new(&mut worksheet_file));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut rows: Vec<RawHeaderScanRow> = Vec::new();
    let mut row_lookup: HashMap<u32, usize> = HashMap::new();
    let mut current_row = 0u32;
    let mut current_column = 0usize;
    let mut current_cell_type = String::new();
    let mut current_cell_text = String::new();
    let mut in_cell = false;
    let mut capture_text = false;
    let mut required_shared_strings = HashSet::new();

    loop {
        match reader.read_event_into(&mut buffer).map_err(|error| {
            format!("Nao foi possivel interpretar a planilha '{sheet_name}': {error}")
        })? {
            Event::Start(element) if element.local_name().as_ref() == b"row" => {
                current_row = 0;
                for attribute in element.attributes().with_checks(false).flatten() {
                    if attribute.key.as_ref() == b"r" {
                        current_row = attribute
                            .decoded_and_normalized_value(XmlVersion::Explicit1_0, reader.decoder())
                            .ok()
                            .and_then(|value| value.parse::<u32>().ok())
                            .unwrap_or(0);
                    }
                }

                if current_row > MAX_HEADER_SCAN_ROWS {
                    break;
                }
            }
            Event::Start(element) if element.local_name().as_ref() == b"c" => {
                in_cell = current_row > 0 && current_row <= MAX_HEADER_SCAN_ROWS;
                current_column = 0;
                current_cell_type.clear();
                current_cell_text.clear();

                if in_cell {
                    for attribute in element.attributes().with_checks(false).flatten() {
                        if attribute.key.as_ref() == b"r" {
                            if let Some((row, column)) = attribute
                                .decoded_and_normalized_value(
                                    XmlVersion::Explicit1_0,
                                    reader.decoder(),
                                )
                                .ok()
                                .and_then(|value| parse_xlsx_cell_reference(&value))
                            {
                                current_row = row;
                                current_column = column;
                            }
                        } else if attribute.key.as_ref() == b"t" {
                            current_cell_type = attribute
                                .decoded_and_normalized_value(
                                    XmlVersion::Explicit1_0,
                                    reader.decoder(),
                                )
                                .map(|value| value.into_owned())
                                .unwrap_or_default();
                        }
                    }
                }
            }
            Event::Start(element)
                if in_cell
                    && (element.local_name().as_ref() == b"v"
                        || element.local_name().as_ref() == b"t") =>
            {
                capture_text = true;
            }
            Event::End(element)
                if element.local_name().as_ref() == b"v"
                    || element.local_name().as_ref() == b"t" =>
            {
                capture_text = false;
            }
            Event::Text(text) if in_cell && capture_text => {
                current_cell_text.push_str(&decode_xml_text(text));
            }
            Event::End(element) if element.local_name().as_ref() == b"c" => {
                if in_cell {
                    let value = if current_cell_type == "s" {
                        current_cell_text.trim().parse::<usize>().ok().map(|index| {
                            required_shared_strings.insert(index);
                            ScannedCellValue::Shared(index)
                        })
                    } else {
                        Some(ScannedCellValue::Literal(current_cell_text.clone()))
                    };

                    if let Some(value) = value {
                        let row_index = *row_lookup.entry(current_row).or_insert_with(|| {
                            rows.push(RawHeaderScanRow {
                                row_number: current_row,
                                cells: HashMap::new(),
                            });
                            rows.len() - 1
                        });
                        rows[row_index].cells.insert(current_column, value);
                    }
                }

                in_cell = false;
                capture_text = false;
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    let shared_strings = read_shared_strings_subset(file_path, &required_shared_strings)?;
    let mut resolved_rows = rows
        .into_iter()
        .map(|row| HeaderScanRow {
            row_number: row.row_number,
            cells: row
                .cells
                .into_iter()
                .map(|(column, value)| {
                    let value = match value {
                        ScannedCellValue::Literal(value) => value,
                        ScannedCellValue::Shared(index) => {
                            shared_strings.get(&index).cloned().unwrap_or_default()
                        }
                    };
                    (column, value)
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    resolved_rows.sort_by_key(|row| row.row_number);

    Ok(resolved_rows)
}

fn significant_columns(row: &HeaderScanRow) -> Vec<usize> {
    let mut columns = row
        .cells
        .iter()
        .filter_map(|(column, value)| {
            if value.trim().is_empty() {
                None
            } else {
                Some(*column)
            }
        })
        .collect::<Vec<_>>();
    columns.sort_unstable();
    columns
}

fn row_string_count(row: &HeaderScanRow) -> usize {
    row.cells
        .values()
        .filter(|value| value.chars().any(|character| character.is_alphabetic()))
        .count()
}

fn detect_header_from_rows(rows: &[HeaderScanRow]) -> Result<HeaderDetection, String> {
    let mut best: Option<(i32, u32, usize)> = None;

    for (index, row) in rows.iter().enumerate() {
        let columns = significant_columns(row);
        let non_empty = columns.len();

        if non_empty < 2 {
            continue;
        }

        let next_columns = rows
            .get(index + 1)
            .map(significant_columns)
            .unwrap_or_default();
        let previous_non_empty = index
            .checked_sub(1)
            .and_then(|previous| rows.get(previous))
            .map(significant_columns)
            .map(|columns| columns.len())
            .unwrap_or(0);
        let last_column = columns.iter().copied().max().unwrap_or(0);
        let overlap = columns
            .iter()
            .filter(|column| next_columns.contains(column))
            .count();
        let mut score = (non_empty as i32) * 10 + (row_string_count(row) as i32) * 3;

        if next_columns.len() >= 2 {
            score += 25;
            score += overlap.min(non_empty) as i32 * 2;
        }

        if previous_non_empty <= 1 {
            score += 6;
        }

        if next_columns.len().abs_diff(non_empty) <= 2 {
            score += 8;
        }

        if score >= 30
            && best
                .map(|(best_score, _, _)| score > best_score)
                .unwrap_or(true)
        {
            best = Some((score, row.row_number, last_column + 1));
        }
    }

    if let Some((_, header_row, column_count)) = best {
        return Ok(HeaderDetection {
            header_row,
            column_count,
            rows_scanned: rows.len(),
            fallback_used: false,
        });
    }

    for (index, row) in rows.iter().enumerate() {
        let columns = significant_columns(row);

        if columns.len() != 1 {
            continue;
        }

        let current_value = row
            .cells
            .get(&columns[0])
            .map(|value| value.as_str())
            .unwrap_or_default();
        let next_single = rows.get(index + 1).and_then(|next_row| {
            let next_columns = significant_columns(next_row);
            if next_columns.len() == 1 {
                next_row.cells.get(&next_columns[0])
            } else {
                None
            }
        });
        let row_after_next_is_single = rows
            .get(index + 2)
            .map(significant_columns)
            .map(|columns| columns.len() == 1)
            .unwrap_or(false);

        if current_value
            .chars()
            .any(|character| character.is_alphabetic())
            && next_single
                .map(|value| value.chars().any(|character| character.is_alphabetic()))
                .unwrap_or(false)
            && row_after_next_is_single
        {
            continue;
        }

        let following_single_rows = rows
            .iter()
            .skip(index + 1)
            .take(3)
            .filter(|next_row| significant_columns(next_row).len() == 1)
            .count();

        if following_single_rows >= 2 || (index == 0 && following_single_rows >= 1) {
            return Ok(HeaderDetection {
                header_row: row.row_number,
                column_count: columns[0] + 1,
                rows_scanned: rows.len(),
                fallback_used: true,
            });
        }
    }

    Err("Nao foi possivel identificar com seguranca o cabecalho desta planilha.".to_string())
}

fn detect_excel_header(file_path: &PathBuf, sheet_name: &str) -> Result<HeaderDetection, String> {
    let rows = scan_sheet_header_rows(file_path, sheet_name)?;
    let detection = detect_header_from_rows(&rows)?;

    eprintln!(
        "EXCEL_HEADER_DETECTION\nsheet_name: {sheet_name}\nrows_scanned: {}\ndetected_header_row: {}\ndetected_column_count: {}\nfallback_used: {}",
        detection.rows_scanned,
        detection.header_row,
        detection.column_count,
        detection.fallback_used
    );

    Ok(detection)
}

fn xlsx_range_for_detection(detection: &HeaderDetection) -> Result<String, String> {
    if detection.column_count == 0 {
        return Err("A linha de cabecalho detectada nao possui colunas.".to_string());
    }

    let end_column = xlsx_column_name(detection.column_count - 1);
    Ok(format!("A{}:{end_column}", detection.header_row))
}

fn inspect_excel_workbook_blocking(path: String) -> Result<ExcelWorkbookInspection, String> {
    let start = Instant::now();
    let file_path = PathBuf::from(&path);
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !matches!(extension.as_str(), "xlsx" | "xlsm") {
        return Err("A inspecao de abas aceita apenas arquivos .xlsx ou .xlsm.".to_string());
    }

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("arquivo.xlsx")
        .to_string();
    let sheets = inspect_excel_workbook_metadata(&file_path).map_err(|error| {
        log_excel_import_error("inspect_excel_workbook", None, &error, start.elapsed());
        if error == "O arquivo nao possui planilhas importaveis." {
            error
        } else {
            "Nao foi possivel ler a estrutura deste arquivo Excel.".to_string()
        }
    })?;

    Ok(ExcelWorkbookInspection {
        file_name,
        sheets,
        inspection_duration_ms: start.elapsed().as_millis(),
    })
}

#[tauri::command]
async fn inspect_excel_workbook(path: String) -> Result<ExcelWorkbookInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_excel_workbook_blocking(path))
        .await
        .map_err(|error| format!("A inspecao do workbook foi interrompida: {error}"))?
}

fn cell_to_string(value: &DataRef<'_>) -> String {
    match value {
        DataRef::Empty => String::new(),
        DataRef::Int(value) => value.to_string(),
        DataRef::Float(value) => value.to_string(),
        DataRef::String(value) => value.clone(),
        DataRef::SharedString(value) => value.to_string(),
        DataRef::Bool(value) => value.to_string(),
        DataRef::DateTime(value) => value.to_string(),
        DataRef::DateTimeIso(value) => value.clone(),
        DataRef::DurationIso(value) => value.clone(),
        DataRef::Error(value) => value.to_string(),
    }
}

fn value_ref_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Boolean(value) => value.to_string(),
        ValueRef::TinyInt(value) => value.to_string(),
        ValueRef::SmallInt(value) => value.to_string(),
        ValueRef::Int(value) => value.to_string(),
        ValueRef::BigInt(value) => value.to_string(),
        ValueRef::HugeInt(value) => value.to_string(),
        ValueRef::UHugeInt(value) => value.to_string(),
        ValueRef::UTinyInt(value) => value.to_string(),
        ValueRef::USmallInt(value) => value.to_string(),
        ValueRef::UInt(value) => value.to_string(),
        ValueRef::UBigInt(value) => value.to_string(),
        ValueRef::Float(value) => value.to_string(),
        ValueRef::Double(value) => value.to_string(),
        ValueRef::Decimal(value) => value.to_string(),
        ValueRef::Timestamp(_, value) => value.to_string(),
        ValueRef::Text(value) => String::from_utf8_lossy(value).into_owned(),
        ValueRef::Blob(value) | ValueRef::Geometry(value) => format!("<{} bytes>", value.len()),
        ValueRef::Date32(value) => value.to_string(),
        ValueRef::Time64(_, value) => value.to_string(),
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => format!("{months} months, {days} days, {nanos} ns"),
        ValueRef::List(_, _)
        | ValueRef::Enum(_, _)
        | ValueRef::Struct(_, _)
        | ValueRef::Map(_, _)
        | ValueRef::Array(_, _)
        | ValueRef::Union(_, _) => "<valor complexo>".to_string(),
        _ => "<valor nao suportado>".to_string(),
    }
}

fn value_ref_to_cell(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Null => None,
        _ => Some(value_ref_to_string(value)),
    }
}

fn validate_read_query(query: &str) -> Result<String, String> {
    let sql = query.trim().trim_end_matches(';').trim().to_string();

    if sql.is_empty() {
        return Err("Digite uma consulta SQL.".to_string());
    }

    if sql.contains(';') {
        return Err("Execute apenas uma consulta por vez.".to_string());
    }

    let first_token = sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let allowed = matches!(
        first_token.as_str(),
        "select" | "with" | "show" | "describe" | "explain"
    );

    if !allowed {
        return Err(
            "Apenas consultas de leitura sao permitidas: SELECT, WITH, SHOW, DESCRIBE ou EXPLAIN."
                .to_string(),
        );
    }

    Ok(sql)
}

fn insert_row(
    statement: &mut duckdb::Statement<'_>,
    values: &[String],
    display_row_number: usize,
) -> Result<(), String> {
    let params = values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();

    statement
        .execute(params_from_iter(params))
        .map_err(|error| format!("Falha ao inserir a linha {display_row_number}: {error}"))?;

    Ok(())
}

fn append_row(
    appender: &mut duckdb::Appender<'_>,
    values: &[String],
    display_row_number: usize,
) -> Result<(), String> {
    let params = values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();

    appender
        .append_row(params.as_slice())
        .map_err(|error| format!("Falha ao inserir a linha {display_row_number}: {error}"))?;

    Ok(())
}

fn register_document(
    connection: &Connection,
    document_id: &str,
    workspace_id: &str,
    document_name: &str,
    sheet_name: &str,
    table_name: &str,
    row_count: usize,
    column_count: usize,
    imported_at: &str,
    import_duration_ms: Option<u128>,
    import_performance_json: Option<&str>,
    source_type: &str,
    source_file_name: &str,
    source_sheet_name: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "INSERT INTO {} (
                    id,
                    workspace_id,
                    file_name,
                    sheet_name,
                    table_name,
                    row_count,
                    column_count,
                    imported_at,
                    import_duration_ms,
                    import_performance_json,
                    source_type,
                    source_file_name,
                    source_sheet_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![
                document_id,
                workspace_id,
                document_name,
                sheet_name,
                table_name,
                row_count as i64,
                column_count as i64,
                imported_at,
                import_duration_ms.map(|duration| duration as i64),
                import_performance_json,
                source_type,
                source_file_name,
                source_sheet_name
            ],
        )
        .map_err(|error| format!("Nao foi possivel registrar o documento: {error}"))?;

    Ok(())
}

fn update_document_import_performance(
    connection: &Connection,
    document_id: &str,
    import_performance_json: &str,
) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "UPDATE {} SET import_performance_json = ? WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![import_performance_json, document_id],
        )
        .map_err(|error| format!("Nao foi possivel atualizar metricas de importacao: {error}"))?;

    Ok(())
}

fn ensure_unique_document_name(
    connection: &Connection,
    workspace_id: &str,
    document_name: &str,
    excluding_document_id: Option<&str>,
) -> Result<(), String> {
    let count = match excluding_document_id {
        Some(document_id) => connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM {}
                 WHERE workspace_id = ? AND lower(file_name) = lower(?) AND id <> ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![workspace_id, document_name, document_id],
            |row| row.get::<_, i64>(0),
        ),
        None => connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM {}
                 WHERE workspace_id = ? AND lower(file_name) = lower(?)",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![workspace_id, document_name],
            |row| row.get::<_, i64>(0),
        ),
    }
    .map_err(|error| format!("Nao foi possivel validar o nome do documento: {error}"))?;

    if count > 0 {
        return Err(format!(
            "Ja existe um documento chamado \"{document_name}\" neste workspace."
        ));
    }

    Ok(())
}

fn get_document_table(connection: &Connection, document_id: &str) -> Result<String, String> {
    connection
        .query_row(
            &format!(
                "SELECT table_name FROM {} WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![document_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Documento nao encontrado: {error}"))
}

fn get_document_record(
    connection: &Connection,
    document_id: &str,
) -> Result<DocumentRecord, String> {
    connection
        .query_row(
            &format!(
                "SELECT id, workspace_id, file_name, table_name FROM {} WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![document_id],
            |row| {
                Ok(DocumentRecord {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    file_name: row.get(2)?,
                    table_name: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("Documento nao encontrado: {error}"))
}

fn list_document_records(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Vec<DocumentRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, workspace_id, file_name, table_name
             FROM {}
             WHERE workspace_id = ?
             ORDER BY CAST(imported_at AS BIGINT) DESC",
            quoted_identifier(DOCUMENTS_TABLE)
        ))
        .map_err(|error| format!("Nao foi possivel listar fontes SQL: {error}"))?;

    statement
        .query_map(params![workspace_id], |row| {
            Ok(DocumentRecord {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                file_name: row.get(2)?,
                table_name: row.get(3)?,
            })
        })
        .map_err(|error| format!("Nao foi possivel consultar fontes SQL: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar fontes SQL: {error}"))
}

fn create_logical_document_view(
    connection: &Connection,
    logical_name: &str,
    physical_table_name: &str,
) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE OR REPLACE TEMP VIEW {} AS SELECT * FROM {}",
                quoted_identifier(logical_name),
                table_sql(physical_table_name)
            ),
            [],
        )
        .map_err(|error| {
            format!("Nao foi possivel preparar a fonte logica \"{logical_name}\": {error}")
        })?;

    Ok(())
}

fn ensure_unambiguous_logical_names(documents: &[DocumentRecord]) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut duplicate_names = Vec::new();

    for document in documents {
        let normalized = document.file_name.trim().to_lowercase();
        if !seen.insert(normalized) {
            duplicate_names.push(document.file_name.clone());
        }
    }

    duplicate_names.sort();
    duplicate_names.dedup();

    if !duplicate_names.is_empty() {
        return Err(format!(
            "Existem documentos com nome duplicado neste workspace: {}. Renomeie para usar nomes logicos no SQL.",
            duplicate_names.join(", ")
        ));
    }

    Ok(())
}

fn prepare_sql_context(
    connection: &Connection,
    context_mode: &str,
    workspace_id: Option<String>,
    document_id: Option<String>,
) -> Result<Option<String>, String> {
    match context_mode {
        "document" => {
            let document_id = document_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Selecione um documento para usar o contexto Documento atual.".to_string()
                })?;
            let document = get_document_record(connection, &document_id)?;

            if let Some(workspace_id) = workspace_id.as_deref() {
                if document.workspace_id != workspace_or_default(Some(workspace_id.to_string())) {
                    return Err(
                        "O documento selecionado nao pertence ao workspace atual.".to_string()
                    );
                }
            }

            create_logical_document_view(connection, "documento", &document.table_name)?;
            create_logical_document_view(connection, &document.file_name, &document.table_name)?;
            Ok(Some(document.id))
        }
        "workspace" => {
            let workspace_id = workspace_or_default(workspace_id);
            ensure_workspace_exists(connection, &workspace_id)?;
            let documents = list_document_records(connection, &workspace_id)?;
            ensure_unambiguous_logical_names(&documents)?;

            for document in &documents {
                create_logical_document_view(
                    connection,
                    &document.file_name,
                    &document.table_name,
                )?;
            }

            Ok(None)
        }
        _ => Err("Contexto SQL invalido.".to_string()),
    }
}

fn sql_source_info(
    connection: &Connection,
    document: DocumentRecord,
) -> Result<SqlSourceInfo, String> {
    let columns = get_columns(connection, &document.table_name)?;
    let column_types = get_column_data_types(connection, &document.table_name, &columns)?;

    Ok(SqlSourceInfo {
        id: document.id,
        name: document.file_name,
        table_name: document.table_name,
        columns,
        column_types,
    })
}

fn parse_import_performance(value: Option<String>) -> Option<ImportPerformanceSnapshot> {
    value.and_then(|json| serde_json::from_str(&json).ok())
}

fn get_columns(connection: &Connection, table_name: &str) -> Result<Vec<String>, String> {
    let mut columns_statement = connection
        .prepare(
            "SELECT column_name
             FROM information_schema.columns
             WHERE table_name = ?
             ORDER BY ordinal_position",
        )
        .map_err(|error| format!("Nenhuma tabela importada encontrada: {error}"))?;
    let columns = columns_statement
        .query_map(params![table_name], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Nao foi possivel ler as colunas: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar as colunas: {error}"))?;

    if columns.is_empty() {
        return Err("Nenhuma tabela importada encontrada.".to_string());
    }

    Ok(columns)
}

fn get_column_data_type(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<String, String> {
    connection
        .query_row(
            "SELECT data_type
             FROM information_schema.columns
             WHERE table_name = ? AND column_name = ?",
            params![table_name, column_name],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Coluna nao encontrada no schema real da tabela: {error}"))
}

fn get_column_data_types(
    connection: &Connection,
    table_name: &str,
    columns: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut types = HashMap::with_capacity(columns.len());

    for column in columns {
        types.insert(
            column.clone(),
            get_column_data_type(connection, table_name, column)?,
        );
    }

    Ok(types)
}

fn is_textual_type(data_type: &str) -> bool {
    let normalized = data_type.to_ascii_uppercase();
    normalized.contains("CHAR")
        || normalized == "TEXT"
        || normalized == "STRING"
        || normalized == "VARCHAR"
        || normalized == "UUID"
}

fn validate_cell_value_type(
    connection: &Connection,
    data_type: &str,
    value: Option<&str>,
) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };

    if is_textual_type(data_type) {
        return Ok(());
    }

    let sql = format!("SELECT TRY_CAST(? AS {data_type}) IS NOT NULL");
    let is_valid = connection
        .query_row(&sql, params![value], |row| row.get::<_, bool>(0))
        .map_err(|error| format!("Nao foi possivel validar o tipo da celula: {error}"))?;

    if !is_valid {
        return Err(format!("Valor invalido para coluna do tipo {data_type}."));
    }

    Ok(())
}

fn sanitize_filters(filters: Vec<ColumnFilter>, columns: &[String]) -> Vec<ColumnFilter> {
    filters
        .into_iter()
        .filter_map(|filter| {
            let value = filter.value.trim().to_string();
            let operator = match filter.operator.as_str() {
                "empty" => "empty",
                "equals" => "equals",
                "quality_violation" => "quality_violation",
                _ => "contains",
            }
            .to_string();

            if !columns.iter().any(|column| column == &filter.column) {
                return None;
            }

            if operator == "quality_violation"
                && filter.rule_id.as_deref().unwrap_or("").trim().is_empty()
            {
                return None;
            }

            if operator != "empty" && operator != "quality_violation" && value.is_empty() {
                return None;
            }

            Some(ColumnFilter {
                column: filter.column,
                operator,
                value,
                rule_id: filter.rule_id,
            })
        })
        .collect()
}

fn build_where_clause(
    connection: &Connection,
    table_name: Option<&str>,
    filters: &[ColumnFilter],
) -> Result<(String, Vec<String>), String> {
    if filters.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let mut conditions = Vec::new();
    let mut params = Vec::new();

    for filter in filters {
        let column = quoted_identifier(&filter.column);

        match filter.operator.as_str() {
            "empty" => conditions.push(format!(
                "({column} IS NULL OR TRIM(CAST({column} AS VARCHAR)) = '')"
            )),
            "equals" => {
                conditions.push(format!("CAST({column} AS VARCHAR) = ?"));
                params.push(filter.value.clone());
            }
            "quality_violation" => {
                let table_name = table_name.ok_or_else(|| {
                    "Filtros de qualidade estao disponiveis apenas para documentos.".to_string()
                })?;
                let rule_id = filter
                    .rule_id
                    .as_deref()
                    .ok_or_else(|| "Regra de qualidade nao informada.".to_string())?;
                let rule = quality::get_rule(connection, rule_id)?;
                if rule.column_name != filter.column {
                    return Err("Regra de qualidade nao pertence a coluna filtrada.".to_string());
                }
                let condition = quality::build_condition_for_rule(&rule, table_name, None)?;
                conditions.push(condition.sql);
                params.extend(condition.params);
            }
            _ => {
                conditions.push(format!(
                    "LOWER(COALESCE(CAST({column} AS VARCHAR), '')) LIKE ?"
                ));
                params.push(format!("%{}%", filter.value.to_lowercase()));
            }
        }
    }

    Ok((format!(" WHERE {}", conditions.join(" AND ")), params))
}

fn build_order_clause(
    sort_column: Option<String>,
    sort_direction: Option<String>,
    columns: &[String],
) -> (String, Option<String>, Option<String>) {
    let Some(column) = sort_column.filter(|column| columns.iter().any(|item| item == column))
    else {
        return (String::new(), None, None);
    };
    let direction = match sort_direction.as_deref() {
        Some("desc") => "desc",
        _ => "asc",
    };
    let sql_direction = if direction == "desc" { "DESC" } else { "ASC" };

    (
        format!(
            " ORDER BY NULLIF({}, '') {sql_direction} NULLS LAST",
            quoted_identifier(&column)
        ),
        Some(column),
        Some(direction.to_string()),
    )
}

fn get_source_columns(connection: &Connection, source_sql: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT * FROM ({source_sql}) AS source_query LIMIT 0"
        ))
        .map_err(|error| format!("Nao foi possivel preparar a fonte SQL: {error}"))?;
    let query = statement
        .query([])
        .map_err(|error| format!("Nao foi possivel ler as colunas da consulta: {error}"))?;
    let columns = query
        .as_ref()
        .ok_or_else(|| "Consulta sem resultado tabular.".to_string())?
        .column_names();

    if columns.is_empty() {
        return Err("A consulta nao retornou colunas.".to_string());
    }

    Ok(columns)
}

fn get_source_stats(
    connection: &Connection,
    source_sql: &str,
    columns: &[String],
) -> Result<TableStats, String> {
    let mut quality = Vec::with_capacity(columns.len());
    let mut empty_cells = 0usize;

    for column in columns {
        let empty_count = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM ({source_sql}) AS source_query WHERE {} IS NULL OR TRIM(CAST({} AS VARCHAR)) = ''",
                    quoted_identifier(column),
                    quoted_identifier(column)
                ),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Nao foi possivel calcular vazios em '{column}': {error}"))?
            .max(0) as usize;

        empty_cells += empty_count;

        if empty_count > 0 {
            quality.push(ColumnQuality {
                column: column.clone(),
                empty_count,
            });
        }
    }

    Ok(TableStats {
        column_count: columns.len(),
        columns_with_empty: quality.len(),
        empty_cells,
        quality,
    })
}

fn get_page_from_source(
    connection: &Connection,
    source_sql: &str,
    table_name: Option<&str>,
    columns: Vec<String>,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<TablePage, String> {
    let safe_limit = limit.clamp(25, 500);
    let safe_offset = offset;
    let stats = get_source_stats(connection, source_sql, &columns)?;
    let active_filters = sanitize_filters(filters, &columns);
    let (where_clause, filter_values) =
        build_where_clause(connection, table_name, &active_filters)?;
    let (order_clause, safe_sort_column, safe_sort_direction) =
        build_order_clause(sort_column, sort_direction, &columns);
    let filter_refs = filter_values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();

    let total_rows = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM ({source_sql}) AS source_query{where_clause}"),
            params_from_iter(filter_refs.iter().copied()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel contar as linhas: {error}"))?
        .max(0) as usize;

    let sql = format!(
        "SELECT * FROM ({source_sql}) AS source_query{where_clause}{order_clause} LIMIT ? OFFSET ?"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Nao foi possivel preparar a consulta: {error}"))?;
    let mut query_params = filter_values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    let limit_param = safe_limit as i64;
    let offset_param = safe_offset as i64;
    query_params.push(&limit_param);
    query_params.push(&offset_param);
    let mut query = statement
        .query(params_from_iter(query_params))
        .map_err(|error| format!("Nao foi possivel consultar os dados: {error}"))?;
    let mut rows = Vec::new();

    while let Some(row) = query
        .next()
        .map_err(|error| format!("Nao foi possivel ler uma linha: {error}"))?
    {
        let mut values = Vec::with_capacity(columns.len());

        for index in 0..columns.len() {
            let value = row
                .get_ref(index)
                .map_err(|error| format!("Nao foi possivel ler a coluna {}: {error}", index + 1))?;
            values.push(value_ref_to_cell(value));
        }

        rows.push(values);
    }

    Ok(TablePage {
        columns,
        rows,
        total_rows,
        offset: safe_offset,
        limit: safe_limit,
        sort_column: safe_sort_column,
        sort_direction: safe_sort_direction,
        filters: active_filters,
        stats,
    })
}

fn selected_columns(all_columns: &[String], requested_columns: &[String]) -> Vec<String> {
    let selected = requested_columns
        .iter()
        .filter(|column| all_columns.iter().any(|item| item == *column))
        .cloned()
        .collect::<Vec<_>>();

    if selected.is_empty() {
        all_columns.to_vec()
    } else {
        selected
    }
}

fn projection_sql(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| quoted_identifier(column))
        .collect::<Vec<_>>()
        .join(", ")
}

fn get_window_from_source(
    connection: &Connection,
    source_sql: &str,
    table_name: Option<&str>,
    columns: Vec<String>,
    column_types: HashMap<String, String>,
    row_id_projection: Option<String>,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    visible_columns: Vec<String>,
) -> Result<TableWindow, String> {
    let total_start = Instant::now();
    let safe_limit = limit.clamp(25, 500);
    let safe_offset = offset;
    let active_filters = sanitize_filters(filters, &columns);
    let (where_clause, filter_values) =
        build_where_clause(connection, table_name, &active_filters)?;
    let (order_clause, safe_sort_column, safe_sort_direction) =
        build_order_clause(sort_column, sort_direction, &columns);
    let selected_columns = selected_columns(&columns, &visible_columns);
    let projection = projection_sql(&selected_columns);
    let row_id_select = row_id_projection
        .as_ref()
        .map(|projection| format!("{projection}, "))
        .unwrap_or_default();
    let filter_refs = filter_values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();

    let duckdb_start = Instant::now();
    let total_rows = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM ({source_sql}) AS source_query{where_clause}"),
            params_from_iter(filter_refs.iter().copied()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel contar as linhas: {error}"))?
        .max(0) as usize;

    let sql = format!(
        "SELECT {row_id_select}{projection} FROM ({source_sql}) AS source_query{where_clause}{order_clause} LIMIT ? OFFSET ?"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Nao foi possivel preparar a consulta: {error}"))?;
    let mut query_params = filter_values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    let limit_param = safe_limit as i64;
    let offset_param = safe_offset as i64;
    query_params.push(&limit_param);
    query_params.push(&offset_param);
    let mut query = statement
        .query(params_from_iter(query_params))
        .map_err(|error| format!("Nao foi possivel consultar os dados: {error}"))?;
    let duckdb_elapsed = duckdb_start.elapsed();

    let rust_start = Instant::now();
    let mut rows = Vec::new();
    let mut row_ids = Vec::new();

    while let Some(row) = query
        .next()
        .map_err(|error| format!("Nao foi possivel ler uma linha: {error}"))?
    {
        let row_id =
            if row_id_projection.is_some() {
                Some(row.get::<_, i64>(0).map_err(|error| {
                    format!("Nao foi possivel ler o ID interno da linha: {error}")
                })?)
            } else {
                None
            };
        let first_value_index = usize::from(row_id_projection.is_some());
        let mut values = Vec::with_capacity(selected_columns.len());

        for index in 0..selected_columns.len() {
            let value = row
                .get_ref(first_value_index + index)
                .map_err(|error| format!("Nao foi possivel ler a coluna {}: {error}", index + 1))?;
            values.push(value_ref_to_cell(value));
        }

        row_ids.push(row_id);
        rows.push(values);
    }

    let next_offset = safe_offset + rows.len();
    let has_more = next_offset < total_rows;
    let performance = GridPerformance {
        query_duckdb_ms: duckdb_elapsed.as_millis(),
        rust_processing_ms: rust_start.elapsed().as_millis(),
        total_ms: total_start.elapsed().as_millis(),
        rows: rows.len(),
        offset: safe_offset,
        limit: safe_limit,
    };

    eprintln!(
        "[GRID_PERFORMANCE]\nquery_duckdb: {} ms\nrust_processing: {} ms\ntotal: {} ms\nrows: {}\noffset: {}\nlimit: {}",
        performance.query_duckdb_ms,
        performance.rust_processing_ms,
        performance.total_ms,
        performance.rows,
        performance.offset,
        performance.limit
    );

    let stats = get_source_stats(connection, source_sql, &columns)?;

    Ok(TableWindow {
        columns,
        column_types,
        rows,
        row_ids,
        total_rows,
        offset: safe_offset,
        limit: safe_limit,
        has_more,
        next_offset: has_more.then_some(next_offset),
        sort_column: safe_sort_column,
        sort_direction: safe_sort_direction,
        filters: active_filters,
        stats,
        performance,
    })
}

fn profile_cache_key(document_id: &str, column: &str) -> String {
    format!("{document_id}\u{0}{column}")
}

fn invalidate_profile(state: &tauri::State<'_, AppState>, document_id: &str, column: &str) {
    if let Ok(mut cache) = state.column_profile_cache.lock() {
        cache.remove(&profile_cache_key(document_id, column));
    }
}

fn invalidate_document_profiles(state: &tauri::State<'_, AppState>, document_id: &str) {
    if let Ok(mut cache) = state.column_profile_cache.lock() {
        let prefix = format!("{document_id}\u{0}");
        cache.retain(|key, _profile| !key.starts_with(&prefix));
    }
}

fn quality_revision(state: &tauri::State<'_, AppState>, document_id: &str) -> u64 {
    state
        .quality_revisions
        .lock()
        .ok()
        .and_then(|revisions| revisions.get(document_id).copied())
        .unwrap_or(0)
}

fn quality_cache_key(document_id: &str, column: &str, revision: u64) -> String {
    format!("{document_id}\u{0}{column}\u{0}{revision}")
}

fn invalidate_quality(state: &tauri::State<'_, AppState>, document_id: &str) {
    if let Ok(mut revisions) = state.quality_revisions.lock() {
        let entry = revisions.entry(document_id.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
    }

    if let Ok(mut cache) = state.quality_cache.lock() {
        let prefix = format!("{document_id}\u{0}");
        cache.retain(|key, _summary| !key.starts_with(&prefix));
    }
}

fn invalidate_quality_column(state: &tauri::State<'_, AppState>, document_id: &str, _column: &str) {
    invalidate_quality(state, document_id);
}

fn lock_document_for_transformation(
    state: &tauri::State<'_, AppState>,
    document_id: &str,
) -> Result<(), String> {
    let mut locks = state
        .transformation_locks
        .lock()
        .map_err(|_| "Nao foi possivel bloquear o documento para transformacao.".to_string())?;

    if !locks.insert(document_id.to_string()) {
        return Err("Ja existe uma transformacao em andamento neste documento.".to_string());
    }

    Ok(())
}

fn unlock_document_for_transformation(state: &tauri::State<'_, AppState>, document_id: &str) {
    if let Ok(mut locks) = state.transformation_locks.lock() {
        locks.remove(document_id);
    }
}

fn profile_value_sql(column_sql: &str) -> String {
    format!("TRIM(CAST({column_sql} AS VARCHAR))")
}

fn profile_empty_sql(column_sql: &str) -> String {
    format!("{column_sql} IS NULL OR TRIM(CAST({column_sql} AS VARCHAR)) = ''")
}

fn profile_filled_source_sql(table_name: &str, column: &str) -> String {
    let column_sql = quoted_identifier(column);
    let value_sql = profile_value_sql(&column_sql);
    let empty_sql = profile_empty_sql(&column_sql);

    format!(
        "SELECT {value_sql} AS value
         FROM {}
         WHERE NOT ({empty_sql})",
        table_sql(table_name)
    )
}

fn numeric_profile_value_sql() -> &'static str {
    "TRY_CAST(REPLACE(value, ',', '.') AS DOUBLE)"
}

fn percentage(part: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (part as f64 * 100.0) / total as f64
    }
}

fn classify_boolean_value(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "sim" | "s" | "yes" | "y" => Some("Sim"),
        "false" | "0" | "nao" | "não" | "n" | "no" => Some("Nao"),
        _ => None,
    }
}

fn infer_column_type(
    connection: &Connection,
    filled_source: &str,
    filled_count: usize,
) -> Result<InferredColumn, String> {
    if filled_count == 0 {
        return Ok(InferredColumn {
            inferred_type: "text".to_string(),
            date_source: None,
        });
    }

    let excel_serial_condition = date::excel_serial::duckdb_excel_serial_valid_condition("value");
    let sql = format!(
        "SELECT
            SUM(CASE WHEN LOWER(value) IN ('true', 'false', '1', '0', 'sim', 's', 'nao', 'não', 'n', 'yes', 'y', 'no') THEN 1 ELSE 0 END),
            SUM(CASE WHEN regexp_matches(value, '^[+-]?[0-9]+$') THEN 1 ELSE 0 END),
            SUM(CASE WHEN regexp_matches(REPLACE(value, ',', '.'), '^[+-]?([0-9]+(\\.[0-9]+)?|\\.[0-9]+)$') THEN 1 ELSE 0 END),
            SUM(CASE WHEN TRY_CAST(value AS DATE) IS NOT NULL THEN 1 ELSE 0 END),
            SUM(CASE WHEN TRY_CAST(value AS TIMESTAMP) IS NOT NULL THEN 1 ELSE 0 END),
            SUM(CASE WHEN regexp_matches(value, '([ T][0-9]{{1,2}}:[0-9]{{2}})') THEN 1 ELSE 0 END),
            SUM(CASE WHEN {excel_serial_condition} THEN 1 ELSE 0 END)
         FROM ({filled_source}) AS filled_values",
        excel_serial_condition = excel_serial_condition
    );

    let (
        boolean_count,
        integer_count,
        decimal_count,
        date_count,
        datetime_count,
        time_count,
        excel_serial_count,
    ) = connection
        .query_row(&sql, [], |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(1)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0) as usize,
                row.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0) as usize,
            ))
        })
        .map_err(|error| format!("Nao foi possivel inferir o tipo da coluna: {error}"))?;

    let excel_serial_ratio = excel_serial_count as f64 / filled_count as f64;
    let (inferred_type, date_source) = if boolean_count == filled_count {
        ("boolean", None)
    } else if datetime_count == filled_count && time_count > 0 {
        ("datetime", None)
    } else if date_count == filled_count || datetime_count == filled_count {
        ("date", Some("formatted".to_string()))
    } else if excel_serial_ratio >= EXCEL_SERIAL_DATE_INFERENCE_THRESHOLD {
        ("date", Some("excel_serial".to_string()))
    } else if integer_count == filled_count {
        ("integer", None)
    } else if decimal_count == filled_count {
        ("decimal", None)
    } else {
        ("text", None)
    };

    Ok(InferredColumn {
        inferred_type: inferred_type.to_string(),
        date_source,
    })
}

fn get_profile_counts(
    connection: &Connection,
    table_name: &str,
    column: &str,
) -> Result<(usize, usize, usize, usize), String> {
    let column_sql = quoted_identifier(column);
    let empty_sql = profile_empty_sql(&column_sql);
    let value_sql = profile_value_sql(&column_sql);

    connection
        .query_row(
            &format!(
                "SELECT
                    COUNT(*),
                    SUM(CASE WHEN {empty_sql} THEN 1 ELSE 0 END),
                    COUNT(DISTINCT CASE WHEN NOT ({empty_sql}) THEN {value_sql} END)
                 FROM {}",
                table_sql(table_name)
            ),
            [],
            |row| {
                let total = row.get::<_, i64>(0)?.max(0) as usize;
                let empty = row.get::<_, Option<i64>>(1)?.unwrap_or(0).max(0) as usize;
                let distinct = row.get::<_, i64>(2)?.max(0) as usize;
                Ok((total, total.saturating_sub(empty), empty, distinct))
            },
        )
        .map_err(|error| format!("Nao foi possivel calcular metricas gerais da coluna: {error}"))
}

fn get_top_values(
    connection: &Connection,
    filled_source: &str,
) -> Result<Vec<ValueFrequency>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT value, COUNT(*) AS frequency
             FROM ({filled_source}) AS filled_values
             GROUP BY value
             ORDER BY frequency DESC, value ASC
             LIMIT 10"
        ))
        .map_err(|error| format!("Nao foi possivel preparar valores frequentes: {error}"))?;

    statement
        .query_map([], |row| {
            Ok(ValueFrequency {
                value: row.get(0)?,
                count: row.get::<_, i64>(1)?.max(0) as usize,
            })
        })
        .map_err(|error| format!("Nao foi possivel consultar valores frequentes: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar valores frequentes: {error}"))
}

fn get_text_stats(
    connection: &Connection,
    filled_source: &str,
) -> Result<Option<TextStats>, String> {
    connection
        .query_row(
            &format!(
                "SELECT MIN(LENGTH(value)), AVG(LENGTH(value)), MAX(LENGTH(value))
                 FROM ({filled_source}) AS filled_values"
            ),
            [],
            |row| {
                Ok(TextStats {
                    min_length: row.get::<_, Option<i64>>(0)?.map(|value| value as f64),
                    avg_length: row.get::<_, Option<f64>>(1)?,
                    max_length: row.get::<_, Option<i64>>(2)?.map(|value| value as f64),
                })
            },
        )
        .map(Some)
        .map_err(|error| format!("Nao foi possivel calcular estatisticas de texto: {error}"))
}

fn get_numeric_stats(
    connection: &Connection,
    filled_source: &str,
) -> Result<(Option<NumericStats>, Vec<DistributionBucket>), String> {
    let numeric_sql = numeric_profile_value_sql();
    let stats = connection
        .query_row(
            &format!(
                "WITH numeric_values AS (
                    SELECT {numeric_sql} AS number_value
                    FROM ({filled_source}) AS filled_values
                    WHERE {numeric_sql} IS NOT NULL
                 )
                 SELECT
                    MIN(number_value),
                    MAX(number_value),
                    AVG(number_value),
                    median(number_value),
                    STDDEV_SAMP(number_value)
                 FROM numeric_values"
            ),
            [],
            |row| {
                Ok(NumericStats {
                    min: row.get::<_, Option<f64>>(0)?,
                    max: row.get::<_, Option<f64>>(1)?,
                    avg: row.get::<_, Option<f64>>(2)?,
                    median: row.get::<_, Option<f64>>(3)?,
                    stddev: row.get::<_, Option<f64>>(4)?,
                })
            },
        )
        .map_err(|error| format!("Nao foi possivel calcular estatisticas numericas: {error}"))?;

    let mut distribution = Vec::new();

    if let (Some(min), Some(max)) = (stats.min, stats.max) {
        let mut statement = connection
            .prepare(&format!(
                "WITH numeric_values AS (
                    SELECT {numeric_sql} AS number_value
                    FROM ({filled_source}) AS filled_values
                    WHERE {numeric_sql} IS NOT NULL
                 ),
                 bounds AS (
                    SELECT MIN(number_value) AS min_value, MAX(number_value) AS max_value
                    FROM numeric_values
                 ),
                 bucketed AS (
                    SELECT
                        CASE
                            WHEN bounds.max_value = bounds.min_value THEN 0
                            ELSE LEAST({bucket_count} - 1, GREATEST(0, CAST(FLOOR(((number_value - bounds.min_value) / (bounds.max_value - bounds.min_value)) * {bucket_count}) AS BIGINT)))
                        END AS bucket
                    FROM numeric_values, bounds
                 )
                 SELECT bucket, COUNT(*) AS frequency
                 FROM bucketed
                 GROUP BY bucket
                 ORDER BY bucket",
                bucket_count = PROFILE_BUCKET_COUNT
            ))
            .map_err(|error| format!("Nao foi possivel preparar distribuicao numerica: {error}"))?;

        let bucket_width = if (max - min).abs() < f64::EPSILON {
            0.0
        } else {
            (max - min) / PROFILE_BUCKET_COUNT as f64
        };

        distribution = statement
            .query_map([], |row| {
                let bucket = row.get::<_, i64>(0)?.max(0) as usize;
                let bucket_min = if bucket_width == 0.0 {
                    min
                } else {
                    min + bucket_width * bucket as f64
                };
                let bucket_max = if bucket_width == 0.0 {
                    max
                } else if bucket + 1 >= PROFILE_BUCKET_COUNT as usize {
                    max
                } else {
                    min + bucket_width * (bucket + 1) as f64
                };

                Ok(DistributionBucket {
                    bucket,
                    min: bucket_min,
                    max: bucket_max,
                    count: row.get::<_, i64>(1)?.max(0) as usize,
                })
            })
            .map_err(|error| format!("Nao foi possivel consultar distribuicao numerica: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!("Nao foi possivel processar distribuicao numerica: {error}")
            })?;
    }

    Ok((Some(stats), distribution))
}

fn get_date_stats(
    connection: &Connection,
    filled_source: &str,
    date_source: Option<&str>,
) -> Result<Option<DateStats>, String> {
    if date_source == Some("excel_serial") {
        return get_excel_serial_date_stats(connection, filled_source);
    }

    connection
        .query_row(
            &format!(
                "WITH date_values AS (
                    SELECT TRY_CAST(value AS TIMESTAMP) AS date_value
                    FROM ({filled_source}) AS filled_values
                    WHERE TRY_CAST(value AS TIMESTAMP) IS NOT NULL
                 )
                 SELECT MIN(date_value), MAX(date_value)
                 FROM date_values"
            ),
            [],
            |row| {
                let min = row
                    .get_ref(0)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());
                let max = row
                    .get_ref(1)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());

                Ok(DateStats {
                    min,
                    max,
                    predominant_format: date_source.map(|_| "Texto".to_string()),
                    example_original: None,
                    example_interpreted: None,
                })
            },
        )
        .map(Some)
        .map_err(|error| format!("Nao foi possivel calcular estatisticas de data: {error}"))
}

fn get_excel_serial_date_stats(
    connection: &Connection,
    filled_source: &str,
) -> Result<Option<DateStats>, String> {
    let date_value = date::excel_serial::duckdb_excel_serial_date_expression("value");
    connection
        .query_row(
            &format!(
                "WITH date_values AS (
                    SELECT value, {date_value} AS date_value
                    FROM ({filled_source}) AS filled_values
                    WHERE {date_value} IS NOT NULL
                 ),
                 example AS (
                    SELECT value AS example_original, date_value AS example_interpreted
                    FROM date_values
                    ORDER BY value
                    LIMIT 1
                 )
                 SELECT
                    MIN(date_values.date_value),
                    MAX(date_values.date_value),
                    MAX(example.example_original),
                    MAX(example.example_interpreted)
                 FROM date_values
                 LEFT JOIN example ON TRUE"
            ),
            [],
            |row| {
                let min = row
                    .get_ref(0)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());
                let max = row
                    .get_ref(1)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());
                let example_original = row
                    .get_ref(2)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());
                let example_interpreted = row
                    .get_ref(3)
                    .ok()
                    .map(value_ref_to_string)
                    .filter(|value| !value.is_empty());

                Ok(DateStats {
                    min,
                    max,
                    predominant_format: Some("Serial de data do Excel".to_string()),
                    example_original,
                    example_interpreted,
                })
            },
        )
        .map(Some)
        .map_err(|error| format!("Nao foi possivel calcular estatisticas de serial Excel: {error}"))
}

fn get_boolean_stats(
    connection: &Connection,
    filled_source: &str,
    filled_count: usize,
) -> Result<Option<Vec<BooleanStat>>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT LOWER(value), COUNT(*) AS frequency
             FROM ({filled_source}) AS filled_values
             GROUP BY LOWER(value)"
        ))
        .map_err(|error| format!("Nao foi possivel preparar estatisticas booleanas: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("Nao foi possivel consultar estatisticas booleanas: {error}"))?;
    let mut yes_count = 0usize;
    let mut no_count = 0usize;

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Nao foi possivel ler estatisticas booleanas: {error}"))?
    {
        let value = row
            .get::<_, String>(0)
            .map_err(|error| format!("Nao foi possivel ler valor booleano: {error}"))?;
        let count = row.get::<_, i64>(1).unwrap_or(0).max(0) as usize;

        match classify_boolean_value(&value) {
            Some("Sim") => yes_count += count,
            Some("Nao") => no_count += count,
            _ => {}
        }
    }

    Ok(Some(vec![
        BooleanStat {
            label: "Sim".to_string(),
            count: yes_count,
            percentage: percentage(yes_count, filled_count),
        },
        BooleanStat {
            label: "Nao".to_string(),
            count: no_count,
            percentage: percentage(no_count, filled_count),
        },
    ]))
}

fn log_column_profile_performance(
    document_id: &str,
    column: &str,
    inferred_type: &str,
    row_count: usize,
    performance: &ColumnProfilePerformance,
) {
    eprintln!(
        "COLUMN_PROFILE_PERFORMANCE\n\
document_id: {document_id}\n\
column: {column}\n\
inferred_type: {inferred_type}\n\
row_count: {row_count}\n\
duckdb_ms: {}\n\
processing_ms: {}\n\
total_ms: {}\n\
cache_hit: {}",
        performance.duckdb_ms,
        performance.processing_ms,
        performance.total_ms,
        performance.cache_hit
    );
}

fn get_column_profile_blocking(
    app: AppHandle,
    document_id: String,
    column: String,
) -> Result<ColumnProfile, String> {
    let total_start = Instant::now();
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    let column = column.trim().to_string();

    if !columns.iter().any(|item| item == &column) {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }

    let duckdb_start = Instant::now();
    let physical_type = get_column_data_type(&connection, &table_name, &column)?;
    let (total_count, filled_count, empty_count, distinct_count) =
        get_profile_counts(&connection, &table_name, &column)?;
    let filled_source = profile_filled_source_sql(&table_name, &column);
    let inferred = infer_column_type(&connection, &filled_source, filled_count)?;
    let inferred_type = inferred.inferred_type.clone();
    let top_values = get_top_values(&connection, &filled_source)?;

    let (text_stats, numeric_stats, date_stats, boolean_stats, distribution) =
        match inferred_type.as_str() {
            "integer" | "decimal" => {
                let (stats, distribution) = get_numeric_stats(&connection, &filled_source)?;
                (None, stats, None, None, distribution)
            }
            "date" | "datetime" => (
                None,
                None,
                get_date_stats(&connection, &filled_source, inferred.date_source.as_deref())?,
                None,
                Vec::new(),
            ),
            "boolean" => (
                None,
                None,
                None,
                get_boolean_stats(&connection, &filled_source, filled_count)?,
                Vec::new(),
            ),
            _ => (
                get_text_stats(&connection, &filled_source)?,
                None,
                None,
                None,
                Vec::new(),
            ),
        };
    let duckdb_elapsed = duckdb_start.elapsed();
    let processing_start = Instant::now();
    let performance = ColumnProfilePerformance {
        duckdb_ms: duckdb_elapsed.as_millis(),
        processing_ms: processing_start.elapsed().as_millis(),
        total_ms: total_start.elapsed().as_millis(),
        cache_hit: false,
    };

    let profile = ColumnProfile {
        column: column.clone(),
        physical_type,
        inferred_type,
        total_count,
        filled_count,
        empty_count,
        empty_percentage: percentage(empty_count, total_count),
        distinct_count,
        duplicate_count: filled_count.saturating_sub(distinct_count),
        text_stats,
        numeric_stats,
        date_stats,
        boolean_stats,
        top_values,
        distribution,
        performance,
    };

    log_column_profile_performance(
        &document_id,
        &column,
        &profile.inferred_type,
        profile.total_count,
        &profile.performance,
    );

    Ok(profile)
}

fn import_xlsx_blocking(
    app: AppHandle,
    path: String,
    workspace_id: String,
    selected_sheet_name: Option<String>,
    workbook_inspection_ms: Option<u128>,
) -> Result<ImportSummary, String> {
    let total_start = Instant::now();
    let mut performance = ImportPerformance::default();
    let import_strategy = xlsx_import_strategy();
    let file_path = PathBuf::from(&path);
    let validation_start = Instant::now();
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !matches!(extension.as_str(), "xlsx" | "xlsm") {
        return Err(
            "Use arquivos .xlsx ou .xlsm. O importador otimizado ainda nao aceita .xls/.xlsb."
                .to_string(),
        );
    }
    performance.validation += validation_start.elapsed();

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("arquivo.xlsx")
        .to_string();

    if matches!(import_strategy, ImportStrategy::XlsxDirect) {
        let preparation_start = Instant::now();
        let document_id = new_document_id()?;
        let table_name = format!("xlsx_rows_{document_id}");
        let imported_at = now_millis()?.to_string();
        let sheet_name = match selected_sheet_name.as_deref() {
            Some(name) if !name.trim().is_empty() => name.to_string(),
            _ => {
                let inspection_start = Instant::now();
                let detected =
                    first_xlsx_sheet_name_from_workbook_xml(&file_path).map_err(|error| {
                        log_excel_import_error(
                            "inspect_excel_workbook",
                            None,
                            &error,
                            inspection_start.elapsed(),
                        );
                        if error == "O arquivo nao possui planilhas importaveis." {
                            error
                        } else {
                            "Nao foi possivel ler a estrutura deste arquivo Excel.".to_string()
                        }
                    })?;
                performance.excel_workbook_inspection += inspection_start.elapsed();
                detected.unwrap_or_else(|| "Primeira planilha".to_string())
            }
        };
        if let Some(duration) = workbook_inspection_ms {
            performance.excel_workbook_inspection += Duration::from_millis(duration as u64);
        }
        performance.data_preparation += preparation_start.elapsed();

        let header_detection_start = Instant::now();
        let header_detection = detect_excel_header(&file_path, &sheet_name).map_err(|error| {
            log_excel_import_error(
                "detect_excel_header",
                Some(&sheet_name),
                &error,
                header_detection_start.elapsed(),
            );
            format!("Nao foi possivel identificar a estrutura da planilha \"{sheet_name}\".")
        })?;
        let range = xlsx_range_for_detection(&header_detection)?;
        let header_detection_elapsed = header_detection_start.elapsed();
        performance.excel_header_detection += header_detection_elapsed;
        performance.data_preparation += header_detection_elapsed;

        let connection = open_database(&app)?;
        ensure_workspace_exists(&connection, &workspace_id)?;

        let duckdb_xlsx_start = Instant::now();
        let temp_xlsx_path = temp_xlsx_compatibility_path(&app, &document_id)?;
        try_import_xlsx_direct_with_relationship_fallback(
            &connection,
            &file_path,
            &table_name,
            Some(&sheet_name),
            Some(&range),
            &temp_xlsx_path,
        )
        .map_err(|error| {
            log_excel_import_error(
                "duckdb_read_xlsx",
                Some(&sheet_name),
                &error,
                duckdb_xlsx_start.elapsed(),
            );
            format!(
                "Nao foi possivel importar esta planilha.\n\nO arquivo possui uma estrutura XLSX que nao pode ser lida pelo mecanismo de importacao.\n\nDetalhes tecnicos: {error}"
            )
        })?;
        let duckdb_xlsx = duckdb_xlsx_start.elapsed();
        performance.duckdb += duckdb_xlsx;
        performance.duckdb_detail.xlsx_import += duckdb_xlsx;
        performance.excel_sheet_import += duckdb_xlsx;

        let auxiliary_start = Instant::now();
        let row_count = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", quoted_identifier(&table_name)),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Nao foi possivel contar as linhas importadas: {error}"))?
            .max(0) as usize;
        let columns = get_columns(&connection, &table_name)?;

        if columns.len() > MAX_COLUMNS {
            drop_table(&connection, &table_name).ok();
            return Err(format!(
                "A planilha tem {} colunas. O limite atual de seguranca e {MAX_COLUMNS}.",
                columns.len()
            ));
        }

        let import_duration = total_start.elapsed();
        let import_duration_ms = import_duration.as_millis();
        register_document(
            &connection,
            &document_id,
            &workspace_id,
            &sheet_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
            "xlsx",
            &file_name,
            Some(&sheet_name),
        )?;
        let auxiliary_elapsed = auxiliary_start.elapsed();
        performance.auxiliary_structures += auxiliary_elapsed;
        performance.duckdb += auxiliary_elapsed;
        performance.duckdb_detail.final_queries += auxiliary_elapsed;
        let performance_snapshot = performance.snapshot(total_start.elapsed(), import_strategy);
        let import_performance_json = serde_json::to_string(&performance_snapshot)
            .map_err(|error| format!("Nao foi possivel salvar metricas de importacao: {error}"))?;
        update_document_import_performance(&connection, &document_id, &import_performance_json)?;

        performance.log_xlsx(
            &file_name,
            &sheet_name,
            row_count,
            columns.len(),
            total_start.elapsed(),
            import_strategy,
        );

        return Ok(ImportSummary {
            document_id,
            file_name: sheet_name.clone(),
            sheet_name,
            columns,
            row_count,
            imported_at,
            import_duration_ms: Some(import_duration_ms),
            import_performance: Some(performance_snapshot),
        });
    }

    let xlsx_open_start = Instant::now();
    let mut workbook: Xlsx<_> = open_workbook(&file_path)
        .map_err(|error| format!("Nao foi possivel abrir o XLSX: {error}"))?;
    performance.xlsx_open += xlsx_open_start.elapsed();

    let file_open_start = Instant::now();
    fs::metadata(&file_path).ok();
    performance.file_open += file_open_start.elapsed();

    let worksheets_start = Instant::now();
    let sheet_name = workbook
        .sheet_names()
        .into_iter()
        .find(|name| {
            selected_sheet_name
                .as_deref()
                .map(|selected| selected == name)
                .unwrap_or(false)
        })
        .or_else(|| workbook.sheet_names().first().cloned())
        .ok_or_else(|| "O arquivo nao possui planilhas.".to_string())?;

    let mut reader = workbook
        .worksheet_cells_reader(&sheet_name)
        .map_err(|error| format!("Nao foi possivel ler a planilha '{sheet_name}': {error}"))?;
    let dimensions = reader.dimensions();
    performance.worksheets_read += worksheets_start.elapsed();

    let validation_start = Instant::now();
    if dimensions.end.1 < dimensions.start.1 {
        return Err("A planilha esta vazia.".to_string());
    }

    let width = (dimensions.end.1 - dimensions.start.1 + 1) as usize;

    if width == 0 {
        return Err("A primeira linha nao possui colunas.".to_string());
    }

    if width > MAX_COLUMNS {
        return Err(format!(
            "A planilha tem {width} colunas. O limite atual de seguranca e {MAX_COLUMNS}."
        ));
    }
    performance.validation += validation_start.elapsed();

    let header_row = dimensions.start.0;
    let start_column = dimensions.start.1;
    let mut raw_headers = vec![String::new(); width];
    let mut first_data_cell = None;

    loop {
        let worksheets_start = Instant::now();
        let next_cell = reader
            .next_cell()
            .map_err(|error| format!("Falha ao ler uma celula do XLSX: {error}"))?;
        performance.worksheets_read += worksheets_start.elapsed();

        let Some(cell) = next_cell else {
            break;
        };
        let position = cell.get_position();

        if position.0 == header_row {
            let column_index = (position.1 - start_column) as usize;

            if column_index < raw_headers.len() {
                let conversion_start = Instant::now();
                raw_headers[column_index] = cell_to_string(cell.get_value());
                performance.cell_conversion += conversion_start.elapsed();
            }
        } else {
            first_data_cell = Some(cell);
            break;
        }
    }

    let preparation_start = Instant::now();
    let columns = normalized_headers(&raw_headers, width);
    let document_id = new_document_id()?;
    let table_name = format!("xlsx_rows_{document_id}");
    let imported_at = now_millis()?.to_string();
    let placeholders = (0..columns.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let insert_sql = format!(
        "INSERT INTO {} VALUES ({placeholders})",
        quoted_identifier(&table_name)
    );
    performance.data_preparation += preparation_start.elapsed();

    if matches!(import_strategy, ImportStrategy::ArrowBatch) {
        let mut connection = open_database(&app)?;
        ensure_workspace_exists(&connection, &workspace_id)?;

        let duckdb_cleanup_start = Instant::now();
        drop_table(&connection, &table_name)?;
        let duckdb_cleanup = duckdb_cleanup_start.elapsed();
        performance.duckdb += duckdb_cleanup;
        performance.duckdb_detail.table_cleanup += duckdb_cleanup;

        let batch_size = configured_xlsx_batch_size();
        performance.batch_detail.batch_size = batch_size;
        performance.batch_detail.peak_memory_mb = peak_memory_mb();

        let duckdb_start = Instant::now();
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Nao foi possivel iniciar a transacao: {error}"))?;
        let duckdb_transaction_start = duckdb_start.elapsed();
        performance.duckdb += duckdb_transaction_start;

        let duckdb_creation_start = Instant::now();
        create_table_without_drop(&transaction, &table_name, &columns)?;
        let duckdb_creation = duckdb_creation_start.elapsed();
        performance.duckdb += duckdb_creation;
        performance.duckdb_detail.table_creation += duckdb_creation;

        let schema = arrow_schema_for_columns(&columns);
        let mut appender = transaction.appender(&table_name).map_err(|error| {
            format!("Nao foi possivel preparar o appender Arrow DuckDB: {error}")
        })?;
        let mut batch = XlsxArrowBatch::new(width, batch_size);
        let mut row_count = 0usize;
        let mut current_row_number = header_row + 1;
        let mut current_values = vec![String::new(); width];
        let mut has_data_rows = false;

        if let Some(cell) = first_data_cell {
            has_data_rows = true;
            let position = cell.get_position();
            current_row_number = position.0;
            let column_index = (position.1 - start_column) as usize;

            if column_index < current_values.len() {
                let conversion_start = Instant::now();
                current_values[column_index] = cell_to_string(cell.get_value());
                performance.cell_conversion += conversion_start.elapsed();
            }
        }

        loop {
            let worksheets_start = Instant::now();
            let next_cell = reader
                .next_cell()
                .map_err(|error| format!("Falha ao ler uma celula do XLSX: {error}"))?;
            performance.worksheets_read += worksheets_start.elapsed();

            let Some(cell) = next_cell else {
                break;
            };

            has_data_rows = true;
            let position = cell.get_position();

            if position.0 != current_row_number {
                let batch_build_start = Instant::now();
                batch.push_row(&mut current_values);
                row_count += 1;
                let batch_build = batch_build_start.elapsed();
                performance.batch_detail.batch_build += batch_build;
                performance.data_preparation += batch_build;
                current_row_number = position.0;

                if batch.is_full() {
                    let batch_build_start = Instant::now();
                    let record_batch = batch.into_record_batch(Arc::clone(&schema))?;
                    let batch_build = batch_build_start.elapsed();
                    performance.batch_detail.batch_build += batch_build;
                    performance.data_preparation += batch_build;

                    let duckdb_arrow_start = Instant::now();
                    appender
                        .append_record_batch(record_batch)
                        .map_err(|error| {
                            format!("Nao foi possivel importar batch Arrow no DuckDB: {error}")
                        })?;
                    let duckdb_arrow = duckdb_arrow_start.elapsed();
                    performance.duckdb += duckdb_arrow;
                    performance.duckdb_detail.arrow_ingestion += duckdb_arrow;
                    performance.batch_detail.batch_count += 1;
                    performance.batch_detail.peak_memory_mb = performance
                        .batch_detail
                        .peak_memory_mb
                        .max(peak_memory_mb());

                    batch = XlsxArrowBatch::new(width, batch_size);
                }
            }

            let column_index = (position.1 - start_column) as usize;

            if column_index < current_values.len() {
                let conversion_start = Instant::now();
                current_values[column_index] = cell_to_string(cell.get_value());
                performance.cell_conversion += conversion_start.elapsed();
            }
        }

        if has_data_rows {
            let batch_build_start = Instant::now();
            batch.push_row(&mut current_values);
            row_count += 1;
            let batch_build = batch_build_start.elapsed();
            performance.batch_detail.batch_build += batch_build;
            performance.data_preparation += batch_build;
        }

        if !batch.is_empty() {
            let batch_build_start = Instant::now();
            let record_batch = batch.into_record_batch(Arc::clone(&schema))?;
            let batch_build = batch_build_start.elapsed();
            performance.batch_detail.batch_build += batch_build;
            performance.data_preparation += batch_build;

            let duckdb_arrow_start = Instant::now();
            appender
                .append_record_batch(record_batch)
                .map_err(|error| {
                    format!("Nao foi possivel importar batch Arrow no DuckDB: {error}")
                })?;
            let duckdb_arrow = duckdb_arrow_start.elapsed();
            performance.duckdb += duckdb_arrow;
            performance.duckdb_detail.arrow_ingestion += duckdb_arrow;
            performance.batch_detail.batch_count += 1;
            performance.batch_detail.peak_memory_mb = performance
                .batch_detail
                .peak_memory_mb
                .max(peak_memory_mb());
        }

        let duckdb_flush_start = Instant::now();
        appender.flush().map_err(|error| {
            format!("Nao foi possivel finalizar o appender Arrow DuckDB: {error}")
        })?;
        let duckdb_flush = duckdb_flush_start.elapsed();
        performance.duckdb += duckdb_flush;
        performance.duckdb_detail.flush += duckdb_flush;
        drop(appender);

        let validation_start = Instant::now();
        let imported_rows = transaction
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", quoted_identifier(&table_name)),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Nao foi possivel validar a importacao Arrow: {error}"))?
            .max(0) as usize;
        if imported_rows != row_count {
            return Err(format!(
                "Validacao da importacao Arrow falhou: esperado {row_count} linhas, obtido {imported_rows}."
            ));
        }
        performance.validation += validation_start.elapsed();

        let duckdb_commit_start = Instant::now();
        transaction
            .commit()
            .map_err(|error| format!("Nao foi possivel salvar a importacao Arrow: {error}"))?;
        let duckdb_commit = duckdb_commit_start.elapsed();
        performance.duckdb += duckdb_commit;
        performance.duckdb_detail.commit += duckdb_commit;

        let import_duration = total_start.elapsed();
        let import_duration_ms = import_duration.as_millis();
        let auxiliary_start = Instant::now();
        register_document(
            &connection,
            &document_id,
            &workspace_id,
            &sheet_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
            "xlsx",
            &file_name,
            Some(&sheet_name),
        )?;
        let auxiliary_elapsed = auxiliary_start.elapsed();
        performance.auxiliary_structures += auxiliary_elapsed;
        performance.duckdb += auxiliary_elapsed;
        performance.duckdb_detail.final_queries += auxiliary_elapsed;
        performance.batch_detail.peak_memory_mb = performance
            .batch_detail
            .peak_memory_mb
            .max(peak_memory_mb());
        let performance_snapshot = performance.snapshot(total_start.elapsed(), import_strategy);
        let import_performance_json = serde_json::to_string(&performance_snapshot)
            .map_err(|error| format!("Nao foi possivel salvar metricas de importacao: {error}"))?;
        update_document_import_performance(&connection, &document_id, &import_performance_json)?;

        eprintln!(
            "BATCH_BENCHMARK\nbatch_size: {}\nbatches: {}\nxlsx_parse_ms: {}\nbatch_build_ms: {}\nduckdb_arrow_ingestion_ms: {}\ntotal_ms: {}\npeak_memory_mb: {}",
            performance.batch_detail.batch_size,
            performance.batch_detail.batch_count,
            ImportPerformance::elapsed_ms(performance.worksheets_read),
            ImportPerformance::elapsed_ms(performance.batch_detail.batch_build),
            ImportPerformance::elapsed_ms(performance.duckdb_detail.arrow_ingestion),
            ImportPerformance::elapsed_ms(total_start.elapsed()),
            performance.batch_detail.peak_memory_mb,
        );

        performance.log_xlsx(
            &file_name,
            &sheet_name,
            row_count,
            columns.len(),
            total_start.elapsed(),
            import_strategy,
        );

        return Ok(ImportSummary {
            document_id,
            file_name: sheet_name.clone(),
            sheet_name,
            columns,
            row_count,
            imported_at,
            import_duration_ms: Some(import_duration_ms),
            import_performance: Some(performance_snapshot),
        });
    }

    if matches!(
        import_strategy,
        ImportStrategy::CsvKnownSchema | ImportStrategy::XlsxDirect
    ) {
        let connection = open_database(&app)?;
        ensure_workspace_exists(&connection, &workspace_id)?;

        if matches!(import_strategy, ImportStrategy::XlsxDirect) {
            let duckdb_native_start = Instant::now();
            match try_import_xlsx_with_duckdb_excel(&connection, &file_path, &table_name, &columns)
            {
                Ok(()) => {
                    let duckdb_native = duckdb_native_start.elapsed();
                    performance.duckdb += duckdb_native;
                    performance.duckdb_detail.xlsx_import += duckdb_native;

                    let row_count = connection
                        .query_row(
                            &format!("SELECT COUNT(*) FROM {}", quoted_identifier(&table_name)),
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| {
                            format!("Nao foi possivel contar as linhas importadas: {error}")
                        })?
                        .max(0) as usize;

                    let import_duration = total_start.elapsed();
                    let import_duration_ms = import_duration.as_millis();
                    let auxiliary_start = Instant::now();
                    register_document(
                        &connection,
                        &document_id,
                        &workspace_id,
                        &sheet_name,
                        &sheet_name,
                        &table_name,
                        row_count,
                        columns.len(),
                        &imported_at,
                        Some(import_duration_ms),
                        None,
                        "xlsx",
                        &file_name,
                        Some(&sheet_name),
                    )?;
                    let auxiliary_elapsed = auxiliary_start.elapsed();
                    performance.auxiliary_structures += auxiliary_elapsed;
                    performance.duckdb += auxiliary_elapsed;
                    performance.duckdb_detail.final_queries += auxiliary_elapsed;
                    let performance_snapshot =
                        performance.snapshot(total_start.elapsed(), import_strategy);
                    let import_performance_json = serde_json::to_string(&performance_snapshot)
                        .map_err(|error| {
                            format!("Nao foi possivel salvar metricas de importacao: {error}")
                        })?;
                    update_document_import_performance(
                        &connection,
                        &document_id,
                        &import_performance_json,
                    )?;

                    performance.log_xlsx(
                        &file_name,
                        &sheet_name,
                        row_count,
                        columns.len(),
                        total_start.elapsed(),
                        import_strategy,
                    );

                    return Ok(ImportSummary {
                        document_id,
                        file_name: sheet_name.clone(),
                        sheet_name,
                        columns,
                        row_count,
                        imported_at,
                        import_duration_ms: Some(import_duration_ms),
                        import_performance: Some(performance_snapshot),
                    });
                }
                Err(error) => {
                    eprintln!("PRIMARY_IMPORT_FAILED\nfallback=csv_known_schema\nreason={error}");
                    drop_table(&connection, &table_name).ok();
                }
            }
        }

        let temp_csv_path = temp_import_path(&app, &document_id)?;
        let preparation_start = Instant::now();
        let temp_csv_file = fs::File::create(&temp_csv_path)
            .map_err(|error| format!("Nao foi possivel criar o CSV temporario: {error}"))?;
        let mut csv_writer = BufWriter::new(temp_csv_file);
        write_csv_record(&mut csv_writer, &columns)?;
        performance.data_preparation += preparation_start.elapsed();

        let mut row_count = 0usize;
        let mut current_row_number = header_row + 1;
        let mut current_values = vec![String::new(); width];
        let mut has_data_rows = false;
        let stream_start = Instant::now();

        if let Some(cell) = first_data_cell {
            has_data_rows = true;
            let position = cell.get_position();
            current_row_number = position.0;
            let column_index = (position.1 - start_column) as usize;

            if column_index < current_values.len() {
                current_values[column_index] = cell_to_string(cell.get_value());
            }
        }

        loop {
            let next_cell = reader
                .next_cell()
                .map_err(|error| format!("Falha ao ler uma celula do XLSX: {error}"))?;

            let Some(cell) = next_cell else {
                break;
            };

            has_data_rows = true;
            let position = cell.get_position();

            if position.0 != current_row_number {
                write_csv_record(&mut csv_writer, &current_values)?;
                row_count += 1;
                current_values.fill(String::new());
                current_row_number = position.0;
            }

            let column_index = (position.1 - start_column) as usize;

            if column_index < current_values.len() {
                current_values[column_index] = cell_to_string(cell.get_value());
            }
        }

        if has_data_rows {
            write_csv_record(&mut csv_writer, &current_values)?;
            row_count += 1;
        }

        csv_writer
            .flush()
            .map_err(|error| format!("Nao foi possivel finalizar o CSV temporario: {error}"))?;
        let csv_generation = stream_start.elapsed();
        performance.worksheets_read += csv_generation;
        performance.csv_generation += csv_generation;

        let duckdb_cleanup_start = Instant::now();
        drop_table(&connection, &table_name)?;
        let duckdb_cleanup = duckdb_cleanup_start.elapsed();
        performance.duckdb += duckdb_cleanup;
        performance.duckdb_detail.table_cleanup += duckdb_cleanup;

        let duckdb_creation_start = Instant::now();
        create_table_without_drop(&connection, &table_name, &columns)?;
        let duckdb_creation = duckdb_creation_start.elapsed();
        performance.duckdb += duckdb_creation;
        performance.duckdb_detail.table_creation += duckdb_creation;

        let duckdb_copy_start = Instant::now();
        let csv_path = sql_string_literal(&temp_csv_path.to_string_lossy());
        let copy_sql = format!(
            "COPY {} FROM {csv_path} (
                FORMAT CSV,
                HEADER true,
                DELIMITER ',',
                QUOTE '\"',
                ESCAPE '\"',
                NULL_PADDING true
             )",
            quoted_identifier(&table_name)
        );
        connection.execute(&copy_sql, []).map_err(|error| {
            format!("Nao foi possivel importar o XLSX pelo CSV temporario no DuckDB: {error}")
        })?;
        let duckdb_copy = duckdb_copy_start.elapsed();
        performance.duckdb += duckdb_copy;
        performance.duckdb_detail.copy += duckdb_copy;

        fs::remove_file(&temp_csv_path).ok();

        let import_duration = total_start.elapsed();
        let import_duration_ms = import_duration.as_millis();
        let auxiliary_start = Instant::now();
        register_document(
            &connection,
            &document_id,
            &workspace_id,
            &sheet_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
            "xlsx",
            &file_name,
            Some(&sheet_name),
        )?;
        let auxiliary_elapsed = auxiliary_start.elapsed();
        performance.auxiliary_structures += auxiliary_elapsed;
        performance.duckdb += auxiliary_elapsed;
        performance.duckdb_detail.final_queries += auxiliary_elapsed;
        let performance_snapshot =
            performance.snapshot(total_start.elapsed(), ImportStrategy::CsvKnownSchema);
        let import_performance_json = serde_json::to_string(&performance_snapshot)
            .map_err(|error| format!("Nao foi possivel salvar metricas de importacao: {error}"))?;
        update_document_import_performance(&connection, &document_id, &import_performance_json)?;

        performance.log_xlsx(
            &file_name,
            &sheet_name,
            row_count,
            columns.len(),
            total_start.elapsed(),
            ImportStrategy::CsvKnownSchema,
        );

        return Ok(ImportSummary {
            document_id,
            file_name: sheet_name.clone(),
            sheet_name,
            columns,
            row_count,
            imported_at,
            import_duration_ms: Some(import_duration_ms),
            import_performance: Some(performance_snapshot),
        });
    }

    let mut connection = open_database(&app)?;
    ensure_workspace_exists(&connection, &workspace_id)?;
    let duckdb_cleanup_start = Instant::now();
    drop_table(&connection, &table_name)?;
    let duckdb_cleanup = duckdb_cleanup_start.elapsed();
    performance.duckdb += duckdb_cleanup;
    performance.duckdb_detail.table_cleanup += duckdb_cleanup;

    let duckdb_creation_start = Instant::now();
    create_table_without_drop(&connection, &table_name, &columns)?;
    let duckdb_creation = duckdb_creation_start.elapsed();
    performance.duckdb += duckdb_creation;
    performance.duckdb_detail.table_creation += duckdb_creation;

    let mut row_count = 0usize;
    let mut current_row_number = header_row + 1;
    let mut current_values = vec![String::new(); width];
    let mut has_data_rows = false;

    let duckdb_start = Instant::now();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Nao foi possivel iniciar a transacao: {error}"))?;
    let mut statement =
        if first_data_cell.is_some() && matches!(import_strategy, ImportStrategy::Legacy) {
            Some(
                transaction
                    .prepare(&insert_sql)
                    .map_err(|error| format!("Nao foi possivel preparar a importacao: {error}"))?,
            )
        } else {
            None
        };
    let mut appender =
        if first_data_cell.is_some() && matches!(import_strategy, ImportStrategy::Appender) {
            Some(
                transaction.appender(&table_name).map_err(|error| {
                    format!("Nao foi possivel preparar o appender DuckDB: {error}")
                })?,
            )
        } else {
            None
        };
    performance.duckdb += duckdb_start.elapsed();

    if let Some(cell) = first_data_cell {
        has_data_rows = true;
        let position = cell.get_position();
        current_row_number = position.0;
        let column_index = (position.1 - start_column) as usize;

        if column_index < current_values.len() {
            let conversion_start = Instant::now();
            current_values[column_index] = cell_to_string(cell.get_value());
            performance.cell_conversion += conversion_start.elapsed();
        }
    }

    loop {
        let worksheets_start = Instant::now();
        let next_cell = reader
            .next_cell()
            .map_err(|error| format!("Falha ao ler uma celula do XLSX: {error}"))?;
        performance.worksheets_read += worksheets_start.elapsed();

        let Some(cell) = next_cell else {
            break;
        };
        has_data_rows = true;
        let position = cell.get_position();

        if statement.is_none() && matches!(import_strategy, ImportStrategy::Legacy) {
            let duckdb_start = Instant::now();
            statement = Some(
                transaction
                    .prepare(&insert_sql)
                    .map_err(|error| format!("Nao foi possivel preparar a importacao: {error}"))?,
            );
            performance.duckdb += duckdb_start.elapsed();
        }

        if appender.is_none() && matches!(import_strategy, ImportStrategy::Appender) {
            let duckdb_start = Instant::now();
            appender = Some(transaction.appender(&table_name).map_err(|error| {
                format!("Nao foi possivel preparar o appender DuckDB: {error}")
            })?);
            performance.duckdb += duckdb_start.elapsed();
        }

        if position.0 != current_row_number {
            let duckdb_start = Instant::now();
            match import_strategy {
                ImportStrategy::Legacy => {
                    insert_row(
                        statement
                            .as_mut()
                            .ok_or_else(|| "Importacao nao inicializada.".to_string())?,
                        &current_values,
                        current_row_number as usize + 1,
                    )?;
                }
                ImportStrategy::Appender => {
                    append_row(
                        appender
                            .as_mut()
                            .ok_or_else(|| "Importacao nao inicializada.".to_string())?,
                        &current_values,
                        current_row_number as usize + 1,
                    )?;
                }
                ImportStrategy::CsvKnownSchema
                | ImportStrategy::ArrowBatch
                | ImportStrategy::XlsxDirect => {
                    unreachable!("estrategias em lote retornam antes do fallback linha-a-linha")
                }
            }
            let duckdb_append = duckdb_start.elapsed();
            performance.duckdb += duckdb_append;
            performance.duckdb_detail.appender += duckdb_append;
            row_count += 1;
            current_values.fill(String::new());
            current_row_number = position.0;
        }

        let column_index = (position.1 - start_column) as usize;

        if column_index < current_values.len() {
            let conversion_start = Instant::now();
            current_values[column_index] = cell_to_string(cell.get_value());
            performance.cell_conversion += conversion_start.elapsed();
        }
    }

    if has_data_rows {
        let duckdb_start = Instant::now();
        match import_strategy {
            ImportStrategy::Legacy => {
                insert_row(
                    statement
                        .as_mut()
                        .ok_or_else(|| "Importacao nao inicializada.".to_string())?,
                    &current_values,
                    current_row_number as usize + 1,
                )?;
            }
            ImportStrategy::Appender => {
                append_row(
                    appender
                        .as_mut()
                        .ok_or_else(|| "Importacao nao inicializada.".to_string())?,
                    &current_values,
                    current_row_number as usize + 1,
                )?;
            }
            ImportStrategy::CsvKnownSchema
            | ImportStrategy::ArrowBatch
            | ImportStrategy::XlsxDirect => {
                unreachable!("estrategias em lote retornam antes do fallback linha-a-linha")
            }
        }
        let duckdb_append = duckdb_start.elapsed();
        performance.duckdb += duckdb_append;
        performance.duckdb_detail.appender += duckdb_append;
        row_count += 1;
    }

    drop(statement);
    if let Some(mut appender) = appender.take() {
        let duckdb_flush_start = Instant::now();
        appender
            .flush()
            .map_err(|error| format!("Nao foi possivel finalizar o appender DuckDB: {error}"))?;
        let duckdb_flush = duckdb_flush_start.elapsed();
        performance.duckdb += duckdb_flush;
        performance.duckdb_detail.flush += duckdb_flush;
    }
    drop(appender);

    let duckdb_start = Instant::now();
    transaction
        .commit()
        .map_err(|error| format!("Nao foi possivel salvar a importacao: {error}"))?;
    let duckdb_commit = duckdb_start.elapsed();
    performance.duckdb += duckdb_commit;
    performance.duckdb_detail.commit += duckdb_commit;

    let import_duration = total_start.elapsed();
    let import_duration_ms = import_duration.as_millis();
    let auxiliary_start = Instant::now();
    register_document(
        &connection,
        &document_id,
        &workspace_id,
        &sheet_name,
        &sheet_name,
        &table_name,
        row_count,
        columns.len(),
        &imported_at,
        Some(import_duration_ms),
        None,
        "xlsx",
        &file_name,
        Some(&sheet_name),
    )?;
    let auxiliary_elapsed = auxiliary_start.elapsed();
    performance.auxiliary_structures += auxiliary_elapsed;
    performance.duckdb += auxiliary_elapsed;
    performance.duckdb_detail.final_queries += auxiliary_elapsed;
    let performance_snapshot = performance.snapshot(total_start.elapsed(), import_strategy);
    let import_performance_json = serde_json::to_string(&performance_snapshot)
        .map_err(|error| format!("Nao foi possivel salvar metricas de importacao: {error}"))?;
    update_document_import_performance(&connection, &document_id, &import_performance_json)?;

    performance.log_xlsx(
        &file_name,
        &sheet_name,
        row_count,
        columns.len(),
        total_start.elapsed(),
        import_strategy,
    );

    Ok(ImportSummary {
        document_id,
        file_name: sheet_name.clone(),
        sheet_name,
        columns,
        row_count,
        imported_at,
        import_duration_ms: Some(import_duration_ms),
        import_performance: Some(performance_snapshot),
    })
}

fn import_csv_blocking(
    app: AppHandle,
    path: String,
    workspace_id: String,
) -> Result<ImportSummary, String> {
    let total_start = Instant::now();
    let file_path = PathBuf::from(&path);
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if extension != "csv" {
        return Err("Use arquivos .csv.".to_string());
    }

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("arquivo.csv")
        .to_string();
    let document_id = new_document_id()?;
    let table_name = format!("csv_rows_{document_id}");
    let sheet_name = "CSV".to_string();
    let imported_at = now_millis()?.to_string();
    let connection = open_database(&app)?;
    ensure_workspace_exists(&connection, &workspace_id)?;

    connection
        .execute(
            &format!("DROP TABLE IF EXISTS {}", quoted_identifier(&table_name)),
            [],
        )
        .map_err(|error| format!("Nao foi possivel limpar a tabela anterior: {error}"))?;

    let csv_path = sql_string_literal(&file_path.to_string_lossy());
    let create_sql = format!(
        "CREATE TABLE {} AS
         SELECT *
         FROM read_csv_auto(
            {csv_path},
            header = true,
            all_varchar = true,
            ignore_errors = true,
            null_padding = true
         )",
        quoted_identifier(&table_name)
    );

    connection.execute(&create_sql, []).map_err(|error| {
        format!(
            "Nao foi possivel importar o CSV. Verifique delimitador, aspas e codificacao do arquivo: {error}"
        )
    })?;

    let columns = get_columns(&connection, &table_name)?;

    if columns.len() > MAX_COLUMNS {
        connection
            .execute(
                &format!("DROP TABLE IF EXISTS {}", quoted_identifier(&table_name)),
                [],
            )
            .ok();
        return Err(format!(
            "O CSV tem {} colunas. O limite atual de seguranca e {MAX_COLUMNS}.",
            columns.len()
        ));
    }

    let row_count = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", quoted_identifier(&table_name)),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel contar as linhas importadas: {error}"))?
        .max(0) as usize;

    let import_duration_ms = total_start.elapsed().as_millis();
    register_document(
        &connection,
        &document_id,
        &workspace_id,
        &file_name,
        &sheet_name,
        &table_name,
        row_count,
        columns.len(),
        &imported_at,
        Some(import_duration_ms),
        None,
        "csv",
        &file_name,
        None,
    )?;

    Ok(ImportSummary {
        document_id,
        file_name,
        sheet_name,
        columns,
        row_count,
        imported_at,
        import_duration_ms: Some(import_duration_ms),
        import_performance: None,
    })
}

fn import_document_blocking(
    app: AppHandle,
    path: String,
    workspace_id: Option<String>,
    sheet_name: Option<String>,
    workbook_inspection_ms: Option<u128>,
) -> Result<ImportSummary, String> {
    let workspace_id = workspace_or_default(workspace_id);
    let file_path = PathBuf::from(&path);
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "csv" => import_csv_blocking(app, path, workspace_id),
        "xlsx" | "xlsm" => {
            import_xlsx_blocking(app, path, workspace_id, sheet_name, workbook_inspection_ms)
        }
        _ => Err("Use arquivos .xlsx, .xlsm ou .csv.".to_string()),
    }
}

#[tauri::command]
async fn import_document(
    app: AppHandle,
    path: String,
    workspace_id: Option<String>,
    sheet_name: Option<String>,
    workbook_inspection_ms: Option<u128>,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_document_blocking(app, path, workspace_id, sheet_name, workbook_inspection_ms)
    })
    .await
    .map_err(|error| format!("A importacao foi interrompida: {error}"))?
}

#[tauri::command]
async fn get_column_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    column: String,
) -> Result<ColumnProfile, String> {
    let key = profile_cache_key(&document_id, &column);

    if let Ok(cache) = state.column_profile_cache.lock() {
        if let Some(profile) = cache.get(&key) {
            let mut cached = profile.clone();
            cached.performance = ColumnProfilePerformance {
                duckdb_ms: 0,
                processing_ms: 0,
                total_ms: 0,
                cache_hit: true,
            };
            log_column_profile_performance(
                &document_id,
                &column,
                &cached.inferred_type,
                cached.total_count,
                &cached.performance,
            );
            return Ok(cached);
        }
    }

    let app_for_task = app.clone();
    let document_for_task = document_id.clone();
    let column_for_task = column.clone();
    let profile = tauri::async_runtime::spawn_blocking(move || {
        get_column_profile_blocking(app_for_task, document_for_task, column_for_task)
    })
    .await
    .map_err(|error| format!("A analise da coluna foi interrompida: {error}"))??;

    if let Ok(mut cache) = state.column_profile_cache.lock() {
        cache.insert(key, profile.clone());
    }

    Ok(profile)
}

#[tauri::command]
fn list_quality_rules(
    app: AppHandle,
    document_id: String,
    column_name: Option<String>,
) -> Result<Vec<quality::QualityRule>, String> {
    let connection = open_database(&app)?;
    if let Some(column) = column_name.as_deref() {
        let table_name = get_document_table(&connection, &document_id)?;
        let columns = get_columns(&connection, &table_name)?;
        if !columns.iter().any(|item| item == column) {
            return Err("Coluna nao existe no documento selecionado.".to_string());
        }
    }
    quality::list_rules(&connection, &document_id, column_name.as_deref())
}

#[tauri::command]
fn create_quality_rule(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    input: quality::QualityRuleInput,
) -> Result<quality::QualityRule, String> {
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    if !columns.iter().any(|item| item == &input.column_name) {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }
    let rule = quality::create_rule(&connection, &document_id, input)?;
    invalidate_quality(&state, &document_id);
    Ok(rule)
}

#[tauri::command]
fn update_quality_rule(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    rule_id: String,
    input: quality::QualityRuleInput,
) -> Result<quality::QualityRule, String> {
    let connection = open_database(&app)?;
    let current = quality::get_rule(&connection, &rule_id)?;
    let table_name = get_document_table(&connection, &current.document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    if !columns.iter().any(|item| item == &input.column_name) {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }
    let rule = quality::update_rule(&connection, &rule_id, input)?;
    invalidate_quality(&state, &rule.document_id);
    Ok(rule)
}

#[tauri::command]
fn delete_quality_rule(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    rule_id: String,
) -> Result<(), String> {
    let connection = open_database(&app)?;
    let document_id = quality::delete_rule(&connection, &rule_id)?;
    if let Some(document_id) = document_id {
        invalidate_quality(&state, &document_id);
    }
    Ok(())
}

#[tauri::command]
fn validate_quality_rules(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    column_name: String,
) -> Result<quality::QualityValidationSummary, String> {
    let revision = quality_revision(&state, &document_id);
    let key = quality_cache_key(&document_id, &column_name, revision);
    if let Ok(cache) = state.quality_cache.lock() {
        if let Some(summary) = cache.get(&key) {
            let mut cached = summary.clone();
            cached.performance.cache_hit = true;
            return Ok(cached);
        }
    }

    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    if !columns.iter().any(|item| item == &column_name) {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }
    let rules = quality::list_rules(&connection, &document_id, Some(&column_name))?;
    let summary = quality::validate_rules(
        &connection,
        &document_id,
        &table_name,
        &column_name,
        &rules,
        false,
    )?;
    if let Ok(mut cache) = state.quality_cache.lock() {
        cache.insert(key, summary.clone());
    }
    Ok(summary)
}

#[tauri::command]
fn get_quality_rule_violations(
    app: AppHandle,
    rule_id: String,
    offset: usize,
    limit: usize,
    visible_columns: Vec<String>,
) -> Result<TableWindow, String> {
    let connection = open_database(&app)?;
    let rule = quality::get_rule(&connection, &rule_id)?;
    let table_name = get_document_table(&connection, &rule.document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    get_window_from_source(
        &connection,
        &format!(
            "SELECT rowid AS {}, * FROM {}",
            quoted_identifier(DUCKDB_ROW_ID_ALIAS),
            table_sql(&table_name)
        ),
        Some(&table_name),
        columns,
        get_column_data_types(
            &connection,
            &table_name,
            &get_columns(&connection, &table_name)?,
        )?,
        Some(quoted_identifier(DUCKDB_ROW_ID_ALIAS)),
        offset,
        limit,
        vec![ColumnFilter {
            column: rule.column_name,
            operator: "quality_violation".to_string(),
            value: String::new(),
            rule_id: Some(rule.id),
        }],
        None,
        None,
        visible_columns,
    )
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceInfo>, String> {
    let connection = open_database(&app)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT
                workspaces.id,
                workspaces.name,
                workspaces.created_at,
                COUNT(documents.id) AS document_count
             FROM {} AS workspaces
             LEFT JOIN {} AS documents ON documents.workspace_id = workspaces.id
             GROUP BY workspaces.id, workspaces.name, workspaces.created_at
             ORDER BY
                CASE WHEN workspaces.id = '{}' THEN 0 ELSE 1 END,
                CAST(workspaces.created_at AS BIGINT) DESC",
            quoted_identifier(WORKSPACES_TABLE),
            quoted_identifier(DOCUMENTS_TABLE),
            DEFAULT_WORKSPACE_ID
        ))
        .map_err(|error| format!("Nao foi possivel listar workspaces: {error}"))?;

    statement
        .query_map([], |row| {
            Ok(WorkspaceInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                document_count: row.get::<_, i64>(3)?.max(0) as usize,
            })
        })
        .map_err(|error| format!("Nao foi possivel consultar workspaces: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar workspaces: {error}"))
}

#[tauri::command]
fn create_workspace(app: AppHandle, name: String) -> Result<WorkspaceInfo, String> {
    let name = name.trim();

    if name.is_empty() {
        return Err("Digite um nome para o workspace.".to_string());
    }

    let connection = open_database(&app)?;
    let workspace_id = new_workspace_id()?;
    let created_at = now_millis()?.to_string();

    connection
        .execute(
            &format!(
                "INSERT INTO {} (id, name, created_at) VALUES (?, ?, ?)",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            params![workspace_id, name, created_at],
        )
        .map_err(|error| format!("Nao foi possivel criar o workspace: {error}"))?;

    Ok(WorkspaceInfo {
        id: workspace_id,
        name: name.to_string(),
        created_at,
        document_count: 0,
    })
}

#[tauri::command]
fn update_workspace(
    app: AppHandle,
    workspace_id: String,
    name: String,
) -> Result<WorkspaceInfo, String> {
    let name = name.trim();

    if name.is_empty() {
        return Err("Digite um nome para o workspace.".to_string());
    }

    let connection = open_database(&app)?;
    ensure_workspace_exists(&connection, &workspace_id)?;

    connection
        .execute(
            &format!(
                "UPDATE {} SET name = ? WHERE id = ?",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            params![name, workspace_id],
        )
        .map_err(|error| format!("Nao foi possivel atualizar o workspace: {error}"))?;

    let document_count = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE workspace_id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel contar documentos do workspace: {error}"))?
        .max(0) as usize;

    let created_at = connection
        .query_row(
            &format!(
                "SELECT created_at FROM {} WHERE id = ?",
                quoted_identifier(WORKSPACES_TABLE)
            ),
            params![workspace_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Nao foi possivel recarregar o workspace: {error}"))?;

    Ok(WorkspaceInfo {
        id: workspace_id,
        name: name.to_string(),
        created_at,
        document_count,
    })
}

#[tauri::command]
fn list_documents(
    app: AppHandle,
    workspace_id: Option<String>,
) -> Result<Vec<DocumentInfo>, String> {
    let workspace_id = workspace_or_default(workspace_id);
    let connection = open_database(&app)?;
    ensure_workspace_exists(&connection, &workspace_id)?;

    let mut statement = connection
        .prepare(&format!(
            "SELECT id, workspace_id, file_name, sheet_name, table_name, row_count, column_count, imported_at, import_duration_ms, import_performance_json
             FROM {}
             WHERE workspace_id = ?
             ORDER BY CAST(imported_at AS BIGINT) DESC",
            quoted_identifier(DOCUMENTS_TABLE)
        ))
        .map_err(|error| format!("Nao foi possivel listar documentos: {error}"))?;

    statement
        .query_map(params![workspace_id], |row| {
            Ok(DocumentInfo {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                file_name: row.get(2)?,
                sheet_name: row.get(3)?,
                table_name: row.get(4)?,
                row_count: row.get::<_, i64>(5)?.max(0) as usize,
                column_count: row.get::<_, i64>(6)?.max(0) as usize,
                imported_at: row.get(7)?,
                import_duration_ms: row
                    .get::<_, Option<i64>>(8)?
                    .map(|duration| duration.max(0) as u128),
                import_performance: parse_import_performance(row.get::<_, Option<String>>(9)?),
            })
        })
        .map_err(|error| format!("Nao foi possivel consultar documentos: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar documentos: {error}"))
}

#[tauri::command]
fn delete_document(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;

    connection
        .execute(
            &format!("DROP TABLE IF EXISTS {}", quoted_identifier(&table_name)),
            [],
        )
        .map_err(|error| format!("Nao foi possivel deletar os dados do documento: {error}"))?;
    connection
        .execute(
            &format!(
                "DELETE FROM {} WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![document_id],
        )
        .map_err(|error| format!("Nao foi possivel remover o documento: {error}"))?;
    quality::delete_document_rules(&connection, &document_id)?;
    invalidate_document_profiles(&state, &document_id);
    invalidate_quality(&state, &document_id);

    Ok(())
}

#[tauri::command]
fn rename_document(
    app: AppHandle,
    document_id: String,
    name: String,
) -> Result<DocumentInfo, String> {
    let name = name.trim();

    if name.is_empty() {
        return Err("Digite um nome para o documento.".to_string());
    }

    let connection = open_database(&app)?;
    let current = get_document_record(&connection, &document_id)?;
    ensure_unique_document_name(&connection, &current.workspace_id, name, Some(&document_id))?;

    let updated = connection
        .execute(
            &format!(
                "UPDATE {} SET file_name = ? WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![name, document_id],
        )
        .map_err(|error| format!("Nao foi possivel renomear o documento: {error}"))?;

    if updated == 0 {
        return Err("Documento nao encontrado.".to_string());
    }

    connection
        .query_row(
            &format!(
                "SELECT id, workspace_id, file_name, sheet_name, table_name, row_count, column_count, imported_at, import_duration_ms, import_performance_json
                 FROM {}
                 WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![document_id],
            |row| {
                Ok(DocumentInfo {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    file_name: row.get(2)?,
                    sheet_name: row.get(3)?,
                    table_name: row.get(4)?,
                    row_count: row.get::<_, i64>(5)?.max(0) as usize,
                    column_count: row.get::<_, i64>(6)?.max(0) as usize,
                    imported_at: row.get(7)?,
                    import_duration_ms: row
                        .get::<_, Option<i64>>(8)?
                        .map(|duration| duration.max(0) as u128),
                    import_performance: parse_import_performance(row.get::<_, Option<String>>(9)?),
                })
            },
        )
        .map_err(|error| format!("Nao foi possivel recarregar o documento: {error}"))
}

#[tauri::command]
fn rename_document_column(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    column_index: usize,
    new_column: String,
) -> Result<Vec<String>, String> {
    let new_column = new_column.trim();

    if new_column.is_empty() {
        return Err("Digite um nome para a coluna.".to_string());
    }

    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;

    let old_column = columns
        .get(column_index)
        .ok_or_else(|| "Coluna nao encontrada.".to_string())?;

    if old_column == new_column {
        return Ok(columns);
    }

    if columns.iter().any(|column| column == new_column) {
        return Err("Ja existe uma coluna com esse nome.".to_string());
    }

    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(|error| format!("Nao foi possivel iniciar a renomeacao da coluna: {error}"))?;

    let rename_result = connection
        .execute(
            &format!(
                "ALTER TABLE {} RENAME COLUMN {} TO {}",
                table_sql(&table_name),
                quoted_identifier(old_column),
                quoted_identifier(new_column)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel renomear a coluna: {error}"))
        .and_then(|_| {
            quality::rename_column_rules(&connection, &document_id, old_column, new_column)
        });

    if let Err(error) = rename_result {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(error);
    }

    connection
        .execute_batch("COMMIT")
        .map_err(|error| format!("Nao foi possivel confirmar a renomeacao da coluna: {error}"))?;
    invalidate_profile(&state, &document_id, old_column);
    invalidate_quality(&state, &document_id);

    get_columns(&connection, &table_name)
}

#[tauri::command]
fn preview_transformation(
    app: AppHandle,
    document_id: String,
    transformation: transformations::Transformation,
) -> Result<transformations::TransformationPreview, String> {
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;

    transformations::preview_transformation(&connection, &table_name, &transformation)
}

#[tauri::command]
fn apply_transformation(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    transformation: transformations::Transformation,
) -> Result<transformations::AppliedTransformation, String> {
    lock_document_for_transformation(&state, &document_id)?;

    let result = (|| {
        let connection = open_database(&app)?;
        let table_name = get_document_table(&connection, &document_id)?;
        let column = transformation.column.clone();
        let now = now_millis()?;
        let applied = transformations::apply_transformation(
            &connection,
            &document_id,
            &table_name,
            &transformation,
            now,
        )?;
        invalidate_profile(&state, &document_id, &column);
        invalidate_quality_column(&state, &document_id, &column);
        Ok(applied)
    })();

    unlock_document_for_transformation(&state, &document_id);
    result
}

#[tauri::command]
fn update_document_cell(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document_id: String,
    row_id: i64,
    column: String,
    value: Option<String>,
) -> Result<CellUpdateResult, String> {
    if row_id < 0 {
        return Err("ID interno da linha invalido.".to_string());
    }

    let column = column.trim().to_string();

    if column.is_empty() || column == VALTRON_ROW_ID_COLUMN {
        return Err("Coluna nao editavel.".to_string());
    }

    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;

    if !columns.iter().any(|item| item == &column) {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }

    let data_type = get_column_data_type(&connection, &table_name, &column)?;
    validate_cell_value_type(&connection, &data_type, value.as_deref())?;

    let updated = connection
        .execute(
            &format!(
                "UPDATE {} SET {} = ? WHERE rowid = ?",
                table_sql(&table_name),
                quoted_identifier(&column)
            ),
            params![value.as_deref(), row_id],
        )
        .map_err(|error| format!("UPDATE falhou: {error}"))?;

    if updated == 0 {
        return Err("Linha nao encontrada para atualizacao.".to_string());
    }
    invalidate_profile(&state, &document_id, &column);
    invalidate_quality_column(&state, &document_id, &column);

    Ok(CellUpdateResult {
        row_id,
        column,
        value,
    })
}

fn write_xlsx_zip_entry(
    zip: &mut ZipWriter<fs::File>,
    options: SimpleFileOptions,
    name: &str,
    content: &str,
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|error| format!("Nao foi possivel criar a entrada XLSX {name}: {error}"))?;
    zip.write_all(content.as_bytes())
        .map_err(|error| format!("Nao foi possivel escrever a entrada XLSX {name}: {error}"))
}

fn write_xlsx_text_cell(sheet: &mut String, row_number: usize, column_index: usize, value: &str) {
    let reference = format!("{}{}", xlsx_column_name(column_index), row_number);
    sheet.push_str("<c r=\"");
    sheet.push_str(&reference);
    sheet.push_str("\" t=\"inlineStr\"><is><t>");
    sheet.push_str(&xml_escape(value));
    sheet.push_str("</t></is></c>");
}

fn export_document_xlsx(
    connection: &Connection,
    table_name: &str,
    export_path: &PathBuf,
) -> Result<(), String> {
    let columns = get_columns(connection, table_name)?;
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {}", table_sql(table_name)))
        .map_err(|error| format!("Nao foi possivel preparar exportacao XLSX: {error}"))?;
    let mut query = statement
        .query([])
        .map_err(|error| format!("Nao foi possivel consultar os dados para XLSX: {error}"))?;

    let mut sheet = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );

    sheet.push_str("<row r=\"1\">");
    for (column_index, column) in columns.iter().enumerate() {
        write_xlsx_text_cell(&mut sheet, 1, column_index, column);
    }
    sheet.push_str("</row>");

    let mut row_number = 2usize;
    while let Some(row) = query
        .next()
        .map_err(|error| format!("Nao foi possivel ler uma linha para XLSX: {error}"))?
    {
        sheet.push_str("<row r=\"");
        sheet.push_str(&row_number.to_string());
        sheet.push_str("\">");

        for column_index in 0..columns.len() {
            let value = match row.get_ref(column_index) {
                Ok(ValueRef::Null) => String::new(),
                Ok(ValueRef::Text(value)) => String::from_utf8_lossy(value).to_string(),
                Ok(value) => format!("{value:?}"),
                Err(_) => String::new(),
            };

            write_xlsx_text_cell(&mut sheet, row_number, column_index, &value);
        }

        sheet.push_str("</row>");
        row_number += 1;
    }

    sheet.push_str("</sheetData></worksheet>");
    drop(query);
    drop(statement);

    let file = fs::File::create(export_path)
        .map_err(|error| format!("Nao foi possivel criar o arquivo XLSX: {error}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    write_xlsx_zip_entry(
        &mut zip,
        options,
        "[Content_Types].xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
    )?;
    write_xlsx_zip_entry(
        &mut zip,
        options,
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
    )?;
    write_xlsx_zip_entry(
        &mut zip,
        options,
        "xl/workbook.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
    )?;
    write_xlsx_zip_entry(
        &mut zip,
        options,
        "xl/_rels/workbook.xml.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
    )?;
    write_xlsx_zip_entry(&mut zip, options, "xl/worksheets/sheet1.xml", &sheet)?;
    zip.finish()
        .map_err(|error| format!("Nao foi possivel finalizar o XLSX: {error}"))?;

    Ok(())
}

#[tauri::command]
fn export_document(
    app: AppHandle,
    document_id: String,
    path: String,
    format: String,
) -> Result<(), String> {
    let export_path = PathBuf::from(path.trim());

    if export_path.as_os_str().is_empty() {
        return Err("Escolha um caminho para salvar o arquivo.".to_string());
    }

    if export_path.is_dir() {
        return Err("Escolha um arquivo de destino, nao uma pasta.".to_string());
    }

    let export_format = format.trim().to_ascii_lowercase();

    if let Some(parent) = export_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err("A pasta de destino nao existe.".to_string());
        }
    }

    if export_path.exists() {
        fs::remove_file(&export_path)
            .map_err(|error| format!("Nao foi possivel substituir o arquivo existente: {error}"))?;
    }

    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;

    if export_format == "xlsx" {
        return export_document_xlsx(&connection, &table_name, &export_path);
    }

    let delimiter = match export_format.as_str() {
        "csv" => ",",
        "tsv" => "\t",
        _ => return Err("Formato de exportacao invalido.".to_string()),
    };

    let export_path_sql = sql_string_literal(&export_path.to_string_lossy());
    let delimiter_sql = sql_string_literal(delimiter);
    let export_sql = format!(
        "COPY (SELECT * FROM {}) TO {export_path_sql} (HEADER, DELIMITER {delimiter_sql})",
        table_sql(&table_name)
    );

    connection
        .execute(&export_sql, [])
        .map_err(|error| format!("Nao foi possivel exportar o documento: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_table_page(
    app: AppHandle,
    document_id: String,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<TablePage, String> {
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    get_page_from_source(
        &connection,
        &format!("SELECT * FROM {}", table_sql(&table_name)),
        Some(&table_name),
        columns,
        offset,
        limit,
        filters,
        sort_column,
        sort_direction,
    )
}

#[tauri::command]
fn get_table_window(
    app: AppHandle,
    document_id: String,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    visible_columns: Vec<String>,
) -> Result<TableWindow, String> {
    let connection = open_database(&app)?;
    let table_name = get_document_table(&connection, &document_id)?;
    let columns = get_columns(&connection, &table_name)?;
    let column_types = get_column_data_types(&connection, &table_name, &columns)?;
    get_window_from_source(
        &connection,
        &format!(
            "SELECT rowid AS {}, * FROM {}",
            quoted_identifier(DUCKDB_ROW_ID_ALIAS),
            table_sql(&table_name)
        ),
        Some(&table_name),
        columns,
        column_types,
        Some(quoted_identifier(DUCKDB_ROW_ID_ALIAS)),
        offset,
        limit,
        filters,
        sort_column,
        sort_direction,
        visible_columns,
    )
}

#[tauri::command]
fn get_sql_page(
    app: AppHandle,
    query: String,
    context_mode: Option<String>,
    workspace_id: Option<String>,
    document_id: Option<String>,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<TablePage, String> {
    let sql = validate_read_query(&query)?;
    let connection = open_database(&app)?;
    prepare_sql_context(
        &connection,
        context_mode.as_deref().unwrap_or("document"),
        workspace_id,
        document_id,
    )?;
    let columns = get_source_columns(&connection, &sql)?;
    get_page_from_source(
        &connection,
        &sql,
        None,
        columns,
        offset,
        limit,
        filters,
        sort_column,
        sort_direction,
    )
}

#[tauri::command]
fn get_sql_window(
    app: AppHandle,
    query: String,
    context_mode: Option<String>,
    workspace_id: Option<String>,
    document_id: Option<String>,
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    visible_columns: Vec<String>,
) -> Result<TableWindow, String> {
    let sql = validate_read_query(&query)?;
    let connection = open_database(&app)?;
    prepare_sql_context(
        &connection,
        context_mode.as_deref().unwrap_or("document"),
        workspace_id,
        document_id,
    )?;
    let columns = get_source_columns(&connection, &sql)?;
    get_window_from_source(
        &connection,
        &sql,
        None,
        columns,
        HashMap::new(),
        None,
        offset,
        limit,
        filters,
        sort_column,
        sort_direction,
        visible_columns,
    )
}

#[tauri::command]
fn list_sql_sources(
    app: AppHandle,
    context_mode: Option<String>,
    workspace_id: Option<String>,
    document_id: Option<String>,
) -> Result<Vec<SqlSourceInfo>, String> {
    let connection = open_database(&app)?;
    let context_mode = context_mode.unwrap_or_else(|| "document".to_string());

    match context_mode.as_str() {
        "document" => {
            let document_id = document_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Selecione um documento para listar fontes SQL.".to_string())?;
            let document = get_document_record(&connection, &document_id)?;
            Ok(vec![sql_source_info(&connection, document)?])
        }
        "workspace" => {
            let workspace_id = workspace_or_default(workspace_id);
            ensure_workspace_exists(&connection, &workspace_id)?;
            let documents = list_document_records(&connection, &workspace_id)?;
            ensure_unambiguous_logical_names(&documents)?;
            documents
                .into_iter()
                .map(|document| sql_source_info(&connection, document))
                .collect()
        }
        _ => Err("Contexto SQL invalido.".to_string()),
    }
}

#[tauri::command]
fn save_sql_result_document(
    app: AppHandle,
    query: String,
    name: String,
    context_mode: Option<String>,
    workspace_id: Option<String>,
    source_document_id: Option<String>,
) -> Result<DocumentInfo, String> {
    let document_name = name.trim();

    if document_name.is_empty() {
        return Err("Digite um nome para o novo documento.".to_string());
    }

    let sql = validate_read_query(&query)?;
    let connection = open_database(&app)?;
    let workspace_id = workspace_or_default(workspace_id);
    ensure_workspace_exists(&connection, &workspace_id)?;
    let context_source_document_id = prepare_sql_context(
        &connection,
        context_mode.as_deref().unwrap_or("document"),
        Some(workspace_id.clone()),
        source_document_id.clone(),
    )?;

    let source_document_id = source_document_id
        .or(context_source_document_id)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(document_id) = source_document_id.as_deref() {
        get_document_table(&connection, document_id)?;
    }

    let document_id = new_document_id()?;
    let table_name = format!("sql_rows_{}", document_id);
    let imported_at = now_millis()?.to_string();
    let start = Instant::now();

    connection
        .execute(
            &format!(
                "CREATE TABLE {} AS SELECT * FROM ({sql}) AS sql_result",
                table_sql(&table_name)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel materializar o resultado SQL: {error}"))?;

    let row_count = match connection.query_row(
        &format!("SELECT COUNT(*) FROM {}", table_sql(&table_name)),
        [],
        |row| row.get::<_, i64>(0),
    ) {
        Ok(value) => value.max(0) as usize,
        Err(error) => {
            let _ = connection.execute(
                &format!("DROP TABLE IF EXISTS {}", table_sql(&table_name)),
                [],
            );
            return Err(format!("Nao foi possivel contar o resultado SQL: {error}"));
        }
    };

    let columns = match get_columns(&connection, &table_name) {
        Ok(columns) => columns,
        Err(error) => {
            let _ = connection.execute(
                &format!("DROP TABLE IF EXISTS {}", table_sql(&table_name)),
                [],
            );
            return Err(error);
        }
    };
    let import_duration_ms = start.elapsed().as_millis();

    if let Err(error) = register_document(
        &connection,
        &document_id,
        &workspace_id,
        document_name,
        "Resultado SQL",
        &table_name,
        row_count,
        columns.len(),
        &imported_at,
        Some(import_duration_ms),
        None,
        "sql",
        document_name,
        None,
    ) {
        let _ = connection.execute(
            &format!("DROP TABLE IF EXISTS {}", table_sql(&table_name)),
            [],
        );
        return Err(error);
    }

    let lineage_id = format!("lineage_{}", now_millis()?);
    if let Err(error) = connection.execute(
        &format!(
            "INSERT INTO {} (id, source_document_id, result_document_id, sql, created_at)
             VALUES (?, ?, ?, ?, ?)",
            quoted_identifier(SQL_LINEAGE_TABLE)
        ),
        params![
            lineage_id,
            source_document_id.as_deref(),
            document_id,
            sql,
            imported_at
        ],
    ) {
        let _ = connection.execute(
            &format!(
                "DELETE FROM {} WHERE id = ?",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![document_id],
        );
        let _ = connection.execute(
            &format!("DROP TABLE IF EXISTS {}", table_sql(&table_name)),
            [],
        );
        return Err(format!("Nao foi possivel registrar lineage SQL: {error}"));
    }

    Ok(DocumentInfo {
        id: document_id,
        workspace_id,
        file_name: document_name.to_string(),
        sheet_name: "Resultado SQL".to_string(),
        table_name,
        row_count,
        column_count: columns.len(),
        imported_at,
        import_duration_ms: Some(import_duration_ms),
        import_performance: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            create_workspace,
            update_workspace,
            inspect_excel_workbook,
            import_document,
            get_column_profile,
            list_quality_rules,
            create_quality_rule,
            update_quality_rule,
            delete_quality_rule,
            validate_quality_rules,
            get_quality_rule_violations,
            preview_transformation,
            apply_transformation,
            list_documents,
            delete_document,
            rename_document,
            rename_document_column,
            update_document_cell,
            export_document,
            list_sql_sources,
            get_table_page,
            get_sql_page,
            get_table_window,
            get_sql_window,
            save_sql_result_document
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar o aplicativo Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn duckdb_imports_irregular_csv_as_text() {
        let mut path = std::env::temp_dir();
        path.push(format!("valtron_csv_test_{}.csv", now_millis().unwrap()));
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "nome,idade,cidade").unwrap();
        writeln!(file, "Ana,31,Salvador").unwrap();
        writeln!(file, "Bruno,42").unwrap();
        writeln!(file, "\"Carla\",,Recife").unwrap();
        drop(file);

        let connection = Connection::open_in_memory().unwrap();
        let csv_path = sql_string_literal(&path.to_string_lossy());
        connection
            .execute(
                &format!(
                    "CREATE TABLE csv_test AS
                     SELECT *
                     FROM read_csv_auto(
                        {csv_path},
                        header = true,
                        all_varchar = true,
                        ignore_errors = true,
                        null_padding = true
                     )"
                ),
                [],
            )
            .unwrap();

        let rows = connection
            .query_row("SELECT COUNT(*) FROM csv_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(rows, 3);

        fs::remove_file(path).ok();
    }

    #[test]
    fn duckdb_copies_csv_into_known_text_schema() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_csv_copy_test_{}.csv",
            now_millis().unwrap()
        ));
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "\"codigo\",\"nome\"").unwrap();
        writeln!(file, "\"001234\",\"Ana\"").unwrap();
        writeln!(file, "\"\",\"Bruno\"").unwrap();
        drop(file);

        let connection = Connection::open_in_memory().unwrap();
        create_table_without_drop(
            &connection,
            "csv_copy_test",
            &["codigo".to_string(), "nome".to_string()],
        )
        .unwrap();
        let csv_path = sql_string_literal(&path.to_string_lossy());
        connection
            .execute(
                &format!(
                    "COPY csv_copy_test FROM {csv_path} (
                        FORMAT CSV,
                        HEADER true,
                        DELIMITER ',',
                        QUOTE '\"',
                        ESCAPE '\"',
                        NULL_PADDING true
                     )"
                ),
                [],
            )
            .unwrap();

        let rows = connection
            .query_row("SELECT COUNT(*) FROM csv_copy_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let code = connection
            .query_row(
                "SELECT codigo FROM csv_copy_test WHERE nome = 'Ana'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
        assert_eq!(code, "001234");

        fs::remove_file(path).ok();
    }

    #[test]
    fn duckdb_appends_arrow_record_batch_as_text() {
        let connection = Connection::open_in_memory().unwrap();
        create_table_without_drop(
            &connection,
            "arrow_batch_test",
            &["codigo".to_string(), "nome".to_string()],
        )
        .unwrap();

        let schema = arrow_schema_for_columns(&["codigo".to_string(), "nome".to_string()]);
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![Some("001234"), Some("")])) as ArrayRef,
                Arc::new(StringArray::from(vec![Some("Ana"), Some("Bruno")])) as ArrayRef,
            ],
        )
        .unwrap();

        let mut appender = connection.appender("arrow_batch_test").unwrap();
        appender.append_record_batch(batch).unwrap();
        appender.flush().unwrap();
        drop(appender);

        let rows = connection
            .query_row("SELECT COUNT(*) FROM arrow_batch_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let code = connection
            .query_row(
                "SELECT codigo FROM arrow_batch_test WHERE nome = 'Ana'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(rows, 2);
        assert_eq!(code, "001234");
    }

    fn test_sheet_xml(header: &str, value: &str) -> String {
        let mut sheet = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
        );
        sheet.push_str(r#"<row r="1">"#);
        write_xlsx_text_cell(&mut sheet, 1, 0, header);
        sheet.push_str("</row>");
        sheet.push_str(r#"<row r="2">"#);
        write_xlsx_text_cell(&mut sheet, 2, 0, value);
        sheet.push_str("</row>");
        sheet.push_str("</sheetData></worksheet>");
        sheet
    }

    fn test_sheet_xml_from_rows(rows: &[Vec<&str>], merged_title_width: Option<usize>) -> String {
        let mut sheet = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
        );

        for (row_index, row) in rows.iter().enumerate() {
            let row_number = row_index + 1;
            sheet.push_str(&format!(r#"<row r="{row_number}">"#));

            for (column_index, value) in row.iter().enumerate() {
                if !value.is_empty() {
                    write_xlsx_text_cell(&mut sheet, row_number, column_index, value);
                }
            }

            sheet.push_str("</row>");
        }

        sheet.push_str("</sheetData>");

        if let Some(width) = merged_title_width {
            let end_column = xlsx_column_name(width.saturating_sub(1));
            sheet.push_str(&format!(
                r#"<mergeCells count="1"><mergeCell ref="A1:{end_column}1"/></mergeCells>"#
            ));
        }

        sheet.push_str("</worksheet>");
        sheet
    }

    fn write_test_single_sheet_xlsx(path: &PathBuf, sheet_name: &str, sheet_xml: &str) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        write_xlsx_zip_entry(
            &mut zip,
            options,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/workbook.xml",
            &format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets></workbook>"#, xml_escape(sheet_name)),
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(&mut zip, options, "xl/worksheets/sheet1.xml", sheet_xml).unwrap();
        zip.finish().unwrap();
    }

    fn write_test_prefixed_single_sheet_xlsx(path: &PathBuf, sheet_name: &str, sheet_xml: &str) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        write_xlsx_zip_entry(
            &mut zip,
            options,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/workbook.xml",
            &format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="{}" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>"#, xml_escape(sheet_name)),
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"><rel:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></rel:Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(&mut zip, options, "xl/worksheets/sheet1.xml", sheet_xml).unwrap();
        zip.finish().unwrap();
    }

    fn write_test_multisheet_xlsx(path: &PathBuf) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        write_xlsx_zip_entry(
            &mut zip,
            options,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Primeira" sheetId="1" r:id="rId1"/><sheet name="O'Brien" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#,
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/worksheets/sheet1.xml",
            &test_sheet_xml("codigo", "primeira"),
        )
        .unwrap();
        write_xlsx_zip_entry(
            &mut zip,
            options,
            "xl/worksheets/sheet2.xml",
            &test_sheet_xml("codigo", "segunda"),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    fn real_relationship_problem_xlsx_path() -> Option<PathBuf> {
        let path =
            PathBuf::from("/Users/valdineyfranca/Downloads/escolas_sem_porte20260820_16_43.xlsx");

        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    #[test]
    fn xlsx_direct_imports_selected_sheet_without_cell_preopen() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_multisheet_test_{}.xlsx",
            now_millis().unwrap()
        ));
        write_test_multisheet_xlsx(&path);

        let sheets = inspect_excel_workbook_metadata(&path).unwrap();
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[1].name, "O'Brien");
        assert_eq!(sheets[1].visibility, "hidden");

        let connection = Connection::open_in_memory().unwrap();
        try_import_xlsx_direct_without_preopen(
            &connection,
            &path,
            "selected_sheet_test",
            Some("O'Brien"),
            None,
        )
        .unwrap();

        let rows = connection
            .query_row("SELECT COUNT(*) FROM selected_sheet_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let value = connection
            .query_row("SELECT codigo FROM selected_sheet_test", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();

        assert_eq!(rows, 1);
        assert_eq!(value, "segunda");
        fs::remove_file(path).ok();
    }

    #[test]
    fn xlsx_relationship_error_detector_is_specific() {
        assert!(is_duckdb_xlsx_relationship_id_error(
            "Binder Error: No sheets found in xlsx file (is the file corrupt?)"
        ));
        assert!(!is_duckdb_xlsx_relationship_id_error(
            "Parser Error: syntax error at or near SELECT"
        ));
        assert!(!is_duckdb_xlsx_relationship_id_error(
            "IO Error: No such file or directory"
        ));
        assert!(!is_duckdb_xlsx_relationship_id_error(
            "Permission denied while opening file"
        ));
        assert!(!is_duckdb_xlsx_relationship_id_error(
            "Sheet with name Missing was not found"
        ));
        assert!(!is_duckdb_xlsx_relationship_id_error(
            "DuckDB nao conseguiu criar a tabela diretamente do XLSX: erro generico"
        ));
    }

    #[test]
    fn xlsx_compatible_file_imports_directly_without_relationship_normalization() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_direct_relationship_test_{}.xlsx",
            now_millis().unwrap()
        ));
        write_test_multisheet_xlsx(&path);
        assert!(!xlsx_needs_relationship_id_normalization(&path).unwrap());

        let mut temp_path = std::env::temp_dir();
        temp_path.push(format!(
            "valtron_unused_relationship_temp_{}.xlsx",
            now_millis().unwrap()
        ));
        let connection = Connection::open_in_memory().unwrap();
        try_import_xlsx_direct_with_relationship_fallback(
            &connection,
            &path,
            "direct_relationship_test",
            Some("Primeira"),
            None,
            &temp_path,
        )
        .unwrap();

        let rows = connection
            .query_row("SELECT COUNT(*) FROM direct_relationship_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(rows, 1);
        assert!(!temp_path.exists());
        fs::remove_file(path).ok();
    }

    #[test]
    fn xlsx_relationship_normalization_fallback_imports_problematic_fixture() {
        let Some(path) = real_relationship_problem_xlsx_path() else {
            eprintln!("fixture XLSX real ausente; teste de fallback ignorado");
            return;
        };
        let original_bytes = fs::read(&path).unwrap();
        assert!(xlsx_needs_relationship_id_normalization(&path).unwrap());

        let connection = Connection::open_in_memory().unwrap();
        let direct_error = try_import_xlsx_direct_without_preopen(
            &connection,
            &path,
            "relationship_gap_direct",
            Some("Sheet0"),
            Some("A1:Z"),
        )
        .unwrap_err();
        assert!(is_duckdb_xlsx_relationship_id_error(&direct_error));

        let mut temp_path = std::env::temp_dir();
        temp_path.push(format!(
            "valtron_relationship_gap_temp_{}.xlsx",
            now_millis().unwrap()
        ));
        try_import_xlsx_direct_with_relationship_fallback(
            &connection,
            &path,
            "relationship_gap_imported",
            Some("Sheet0"),
            Some("A1:Z"),
            &temp_path,
        )
        .unwrap();

        let rows = connection
            .query_row(
                "SELECT COUNT(*) FROM relationship_gap_imported",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let columns = get_columns(&connection, "relationship_gap_imported").unwrap();
        let first_id = connection
            .query_row(
                "SELECT id FROM relationship_gap_imported LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(rows, 629);
        assert_eq!(columns.len(), 26);
        assert_eq!(columns[0], "id");
        assert_eq!(first_id, "3395.0");
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
        assert!(!temp_path.exists());
    }

    #[test]
    fn xlsx_relationship_fallback_failure_is_propagated_without_partial_table() {
        let Some(path) = real_relationship_problem_xlsx_path() else {
            eprintln!("fixture XLSX real ausente; teste de falha do fallback ignorado");
            return;
        };

        let mut temp_path = std::env::temp_dir();
        temp_path.push("valtron_missing_parent");
        temp_path.push(format!("compat_{}.xlsx", now_millis().unwrap()));
        let connection = Connection::open_in_memory().unwrap();
        let error = try_import_xlsx_direct_with_relationship_fallback(
            &connection,
            &path,
            "relationship_gap_failed",
            Some("Sheet0"),
            Some("A1:Z"),
            &temp_path,
        )
        .unwrap_err();

        assert!(error.contains("Nao foi possivel criar o XLSX temporario"));
        assert!(get_columns(&connection, "relationship_gap_failed").is_err());
        assert!(!temp_path.exists());
    }

    #[test]
    fn ooxml_parser_accepts_prefixed_workbook_and_worksheet_elements() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_prefixed_ooxml_test_{}.xlsx",
            now_millis().unwrap()
        ));
        let sheet = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns1:worksheet xmlns:ns1="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><ns1:sheetData><ns1:row r="1"><ns1:c r="A1" t="str"><ns1:v>ID</ns1:v></ns1:c><ns1:c r="B1" t="str"><ns1:v>Nome</ns1:v></ns1:c><ns1:c r="C1" t="str"><ns1:v>Cidade</ns1:v></ns1:c></ns1:row><ns1:row r="2"><ns1:c r="A2" t="str"><ns1:v>1</ns1:v></ns1:c><ns1:c r="B2" t="str"><ns1:v>Ana</ns1:v></ns1:c><ns1:c r="C2" t="str"><ns1:v>Salvador</ns1:v></ns1:c></ns1:row><ns1:row r="3"><ns1:c r="A3" t="str"><ns1:v>2</ns1:v></ns1:c><ns1:c r="B3" t="str"><ns1:v>Joao</ns1:v></ns1:c><ns1:c r="C3" t="str"><ns1:v>Recife</ns1:v></ns1:c></ns1:row></ns1:sheetData></ns1:worksheet>"#;
        write_test_prefixed_single_sheet_xlsx(&path, "Clientes", sheet);

        let sheets = inspect_excel_workbook_metadata(&path).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name, "Clientes");

        let detection = detect_excel_header(&path, "Clientes").unwrap();
        assert_eq!(detection.header_row, 1);
        assert_eq!(detection.column_count, 3);

        let rows = scan_sheet_header_rows(&path, "Clientes").unwrap();
        assert_eq!(rows[0].cells.get(&0).unwrap(), "ID");
        assert_eq!(rows[1].cells.get(&1).unwrap(), "Ana");
        fs::remove_file(path).ok();
    }

    #[test]
    fn ooxml_header_scan_treats_inline_str_numeric_boolean_and_str_as_filled() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_inline_str_scan_test_{}.xlsx",
            now_millis().unwrap()
        ));
        let sheet = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>nome</t></is></c>
      <c r="B1" t="inlineStr"><is><t>codigo</t></is></c>
      <c r="C1" t="inlineStr"><is><t>ativo</t></is></c>
      <c r="D1" t="inlineStr"><is><t>observacao</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Ana</t></is></c>
      <c r="B2"><v>123</v></c>
      <c r="C2" t="b"><v>1</v></c>
      <c r="D2" t="str"><v>texto direto</v></c>
    </row>
  </sheetData>
</worksheet>"#;
        write_test_single_sheet_xlsx(&path, "Sheet0", sheet);

        let rows = scan_sheet_header_rows(&path, "Sheet0").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cells.get(&0).unwrap(), "nome");
        assert_eq!(rows[1].cells.get(&0).unwrap(), "Ana");
        assert_eq!(rows[1].cells.get(&1).unwrap(), "123");
        assert_eq!(rows[1].cells.get(&2).unwrap(), "1");
        assert_eq!(rows[1].cells.get(&3).unwrap(), "texto direto");

        let detection = detect_excel_header(&path, "Sheet0").unwrap();
        assert_eq!(detection.header_row, 1);
        assert_eq!(detection.column_count, 4);

        fs::remove_file(path).ok();
    }

    #[test]
    fn detects_header_after_merged_title_and_limits_width() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_header_title_test_{}.xlsx",
            now_millis().unwrap()
        ));
        let sheet = test_sheet_xml_from_rows(
            &[
                vec!["TABELA DE PARCELADOS"],
                vec![
                    "QTO",
                    "MUNICIPIO",
                    "N SEI",
                    "PROGRAMA",
                    "VALOR",
                    "PARCELAS",
                    "TOTAL PARCELADO",
                    "",
                    "",
                ],
                vec!["1", "Alcobaca", "001", "PETE", "10", "2", "20"],
            ],
            Some(7),
        );
        write_test_single_sheet_xlsx(&path, "PAGAMENTO PARCELADOS (2)", &sheet);

        let detection = detect_excel_header(&path, "PAGAMENTO PARCELADOS (2)").unwrap();
        assert_eq!(detection.header_row, 2);
        assert_eq!(detection.column_count, 7);

        let connection = Connection::open_in_memory().unwrap();
        let range = xlsx_range_for_detection(&detection).unwrap();
        try_import_xlsx_direct_without_preopen(
            &connection,
            &path,
            "header_title_test",
            Some("PAGAMENTO PARCELADOS (2)"),
            Some(&range),
        )
        .unwrap();
        let columns = get_columns(&connection, "header_title_test").unwrap();
        let rows = connection
            .query_row("SELECT COUNT(*) FROM header_title_test", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();

        assert_eq!(columns.len(), 7);
        assert_eq!(rows, 1);
        fs::remove_file(path).ok();
    }

    #[test]
    fn detects_header_after_empty_rows_and_preserves_leading_zeroes() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "valtron_header_empty_test_{}.xlsx",
            now_millis().unwrap()
        ));
        let sheet = test_sheet_xml_from_rows(
            &[
                vec![],
                vec![],
                vec![],
                vec!["TABELA DE PARCELADOS"],
                vec![
                    "QTO",
                    "MUNICIPIO",
                    "N SEI",
                    "PROGRAMA",
                    "VALOR DO MONTANTE",
                    "PARCELAS PAGAS ATE O PRESENTE",
                    "PARCELAS INTEGRAIS",
                    "TOTAL PARCELADO",
                    "",
                ],
                vec!["001", "Araci", "SEI-1", "PETE", "10", "1", "2", "20"],
                vec!["010", "Bahia", "SEI-2", "PETE", "30", "3", "4", "40"],
            ],
            None,
        );
        write_test_single_sheet_xlsx(&path, "PARCELAS", &sheet);

        let detection = detect_excel_header(&path, "PARCELAS").unwrap();
        assert_eq!(detection.header_row, 5);
        assert_eq!(detection.column_count, 8);

        let connection = Connection::open_in_memory().unwrap();
        let range = xlsx_range_for_detection(&detection).unwrap();
        try_import_xlsx_direct_without_preopen(
            &connection,
            &path,
            "header_empty_test",
            Some("PARCELAS"),
            Some(&range),
        )
        .unwrap();
        let columns = get_columns(&connection, "header_empty_test").unwrap();
        let first_code = connection
            .query_row("SELECT QTO FROM header_empty_test LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();

        assert_eq!(columns.len(), 8);
        assert_eq!(first_code, "001");
        fs::remove_file(path).ok();
    }

    #[test]
    fn detects_single_column_table_after_title() {
        let rows = vec![
            HeaderScanRow {
                row_number: 1,
                cells: HashMap::from([(0, "RELATORIO DE CODIGOS".to_string())]),
            },
            HeaderScanRow {
                row_number: 2,
                cells: HashMap::from([(0, "codigo".to_string())]),
            },
            HeaderScanRow {
                row_number: 3,
                cells: HashMap::from([(0, "001".to_string())]),
            },
            HeaderScanRow {
                row_number: 4,
                cells: HashMap::from([(0, "002".to_string())]),
            },
        ];

        let detection = detect_header_from_rows(&rows).unwrap();
        assert_eq!(detection.header_row, 2);
        assert_eq!(detection.column_count, 1);
    }

    #[test]
    fn sql_document_context_resolves_documento_and_logical_name() {
        let connection = Connection::open_in_memory().unwrap();
        init_database(&connection).unwrap();
        connection
            .execute(
                "CREATE TABLE physical_pagamentos (\"MUNICÍPIO\" VARCHAR, \"TOTAL PAGO\" VARCHAR)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO physical_pagamentos VALUES ('Aiquara', '12000')",
                [],
            )
            .unwrap();
        register_document(
            &connection,
            "doc_pagamentos",
            DEFAULT_WORKSPACE_ID,
            "ADIMPLENTES POR PAGAMENTO",
            "Planilha1",
            "physical_pagamentos",
            1,
            2,
            "1",
            None,
            None,
            "test",
            "pagamentos.xlsx",
            Some("Planilha1"),
        )
        .unwrap();

        prepare_sql_context(
            &connection,
            "document",
            Some(DEFAULT_WORKSPACE_ID.to_string()),
            Some("doc_pagamentos".to_string()),
        )
        .unwrap();

        let from_alias = connection
            .query_row(
                "SELECT COUNT(*) FROM documento WHERE \"MUNICÍPIO\" = 'Aiquara'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let from_logical_name = connection
            .query_row(
                "SELECT COUNT(*) FROM \"ADIMPLENTES POR PAGAMENTO\" WHERE \"TOTAL PAGO\" = '12000'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(from_alias, 1);
        assert_eq!(from_logical_name, 1);
    }

    #[test]
    fn sql_workspace_context_resolves_document_names_for_join() {
        let connection = Connection::open_in_memory().unwrap();
        init_database(&connection).unwrap();
        connection
            .execute(
                "CREATE TABLE physical_alunos (matricula VARCHAR, nome VARCHAR)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "CREATE TABLE physical_notas (matricula VARCHAR, nota VARCHAR)",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO physical_alunos VALUES ('001', 'Ana')", [])
            .unwrap();
        connection
            .execute("INSERT INTO physical_notas VALUES ('001', '10')", [])
            .unwrap();
        register_document(
            &connection,
            "doc_alunos",
            DEFAULT_WORKSPACE_ID,
            "alunos",
            "Planilha1",
            "physical_alunos",
            1,
            2,
            "1",
            None,
            None,
            "test",
            "alunos.xlsx",
            Some("Planilha1"),
        )
        .unwrap();
        register_document(
            &connection,
            "doc_notas",
            DEFAULT_WORKSPACE_ID,
            "notas",
            "Planilha1",
            "physical_notas",
            1,
            2,
            "2",
            None,
            None,
            "test",
            "notas.xlsx",
            Some("Planilha1"),
        )
        .unwrap();

        prepare_sql_context(
            &connection,
            "workspace",
            Some(DEFAULT_WORKSPACE_ID.to_string()),
            None,
        )
        .unwrap();

        let joined = connection
            .query_row(
                "SELECT a.nome || ':' || n.nota FROM alunos a JOIN notas n ON n.matricula = a.matricula",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(joined, "Ana:10");
    }

    #[test]
    fn sql_workspace_context_rejects_duplicate_logical_names() {
        let connection = Connection::open_in_memory().unwrap();
        init_database(&connection).unwrap();
        connection
            .execute("CREATE TABLE duplicate_a (id VARCHAR)", [])
            .unwrap();
        connection
            .execute("CREATE TABLE duplicate_b (id VARCHAR)", [])
            .unwrap();
        register_document(
            &connection,
            "doc_duplicate_a",
            DEFAULT_WORKSPACE_ID,
            "Duplicado",
            "Planilha1",
            "duplicate_a",
            0,
            1,
            "1",
            None,
            None,
            "test",
            "a.xlsx",
            Some("Planilha1"),
        )
        .unwrap();

        connection
            .execute(
                &format!(
                    "INSERT INTO {} (
                        id, workspace_id, file_name, sheet_name, table_name, row_count,
                        column_count, imported_at, source_type, source_file_name, source_sheet_name
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    quoted_identifier(DOCUMENTS_TABLE)
                ),
                params![
                    "doc_duplicate_b",
                    DEFAULT_WORKSPACE_ID,
                    "Duplicado",
                    "Planilha1",
                    "duplicate_b",
                    0_i64,
                    1_i64,
                    "2",
                    "test",
                    "b.xlsx",
                    "Planilha1"
                ],
            )
            .unwrap();

        let error = prepare_sql_context(
            &connection,
            "workspace",
            Some(DEFAULT_WORKSPACE_ID.to_string()),
            None,
        )
        .unwrap_err();

        assert!(error.contains("nome duplicado"));
    }

    #[test]
    fn profiling_infers_excel_serial_dates_with_interpreted_example() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE serial_profile_test (DATA VARCHAR)", [])
            .unwrap();
        for value in ["33500", "33639", "34122", "35001"] {
            connection
                .execute("INSERT INTO serial_profile_test VALUES (?)", params![value])
                .unwrap();
        }

        let source = profile_filled_source_sql("serial_profile_test", "DATA");
        let inferred = infer_column_type(&connection, &source, 4).unwrap();
        let stats = get_date_stats(&connection, &source, inferred.date_source.as_deref())
            .unwrap()
            .unwrap();

        assert_eq!(inferred.inferred_type, "date");
        assert_eq!(inferred.date_source.as_deref(), Some("excel_serial"));
        assert_eq!(
            stats.predominant_format.as_deref(),
            Some("Serial de data do Excel")
        );
        assert_eq!(stats.example_original.as_deref(), Some("33500"));
        assert!(stats.example_interpreted.is_some());
    }
}
