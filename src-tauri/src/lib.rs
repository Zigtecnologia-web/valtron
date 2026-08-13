use std::{
    fs,
    io::{BufWriter, Read, Write},
    path::PathBuf,
    sync::Arc,
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
use quick_xml::{events::Event, Reader as XmlReader};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const DOCUMENTS_TABLE: &str = "imported_documents";
const WORKSPACES_TABLE: &str = "workspaces";
const DEFAULT_WORKSPACE_ID: &str = "default";
const MAX_COLUMNS: usize = 16_384;

#[derive(Default)]
struct ImportPerformance {
    file_open: Duration,
    xlsx_open: Duration,
    worksheets_read: Duration,
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
    rows: Vec<Vec<String>>,
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
    rows: Vec<Vec<String>>,
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

#[derive(Clone, Deserialize, Serialize)]
struct ColumnFilter {
    column: String,
    value: String,
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
                    import_performance_json TEXT
                )",
                quoted_identifier(DOCUMENTS_TABLE),
                DEFAULT_WORKSPACE_ID
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel inicializar os documentos: {error}"))?;

    ensure_document_workspace_column(connection)?;
    ensure_document_import_duration_column(connection)?;
    ensure_document_import_performance_column(connection)?;
    assign_default_workspace_to_documents(connection)?;

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

fn try_import_xlsx_direct_without_preopen(
    connection: &Connection,
    file_path: &PathBuf,
    table_name: &str,
) -> Result<(), String> {
    connection
        .execute("LOAD excel", [])
        .map_err(|error| format!("Extensao excel indisponivel no DuckDB: {error}"))?;

    drop_table(connection, table_name)?;

    let xlsx_path = sql_string_literal(&file_path.to_string_lossy());
    let create_sql = format!(
        "CREATE TABLE {} AS
         SELECT *
         FROM read_xlsx(
            {xlsx_path},
            header = true,
            all_varchar = true
         )",
        quoted_identifier(table_name)
    );

    connection.execute(&create_sql, []).map_err(|error| {
        format!("DuckDB nao conseguiu criar a tabela diretamente do XLSX: {error}")
    })?;

    Ok(())
}

fn first_xlsx_sheet_name_from_workbook_xml(file_path: &PathBuf) -> Option<String> {
    let file = fs::File::open(file_path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;
    let mut workbook_xml = String::new();
    archive
        .by_name("xl/workbook.xml")
        .ok()?
        .read_to_string(&mut workbook_xml)
        .ok()?;

    let mut reader = XmlReader::from_str(&workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer).ok()? {
            Event::Start(element) | Event::Empty(element)
                if element.name().as_ref() == b"sheet" =>
            {
                for attribute in element.attributes().with_checks(false).flatten() {
                    if attribute.key.as_ref() == b"name" {
                        return attribute
                            .decode_and_unescape_value(reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    }
                }
            }
            Event::Eof => return None,
            _ => {}
        }

        buffer.clear();
    }
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
    file_name: &str,
    sheet_name: &str,
    table_name: &str,
    row_count: usize,
    column_count: usize,
    imported_at: &str,
    import_duration_ms: Option<u128>,
    import_performance_json: Option<&str>,
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
                    import_performance_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                quoted_identifier(DOCUMENTS_TABLE)
            ),
            params![
                document_id,
                workspace_id,
                file_name,
                sheet_name,
                table_name,
                row_count as i64,
                column_count as i64,
                imported_at,
                import_duration_ms.map(|duration| duration as i64),
                import_performance_json
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

fn sanitize_filters(filters: Vec<ColumnFilter>, columns: &[String]) -> Vec<ColumnFilter> {
    filters
        .into_iter()
        .filter_map(|filter| {
            let value = filter.value.trim().to_string();

            if value.is_empty() || !columns.iter().any(|column| column == &filter.column) {
                return None;
            }

            Some(ColumnFilter {
                column: filter.column,
                value,
            })
        })
        .collect()
}

fn build_where_clause(filters: &[ColumnFilter]) -> String {
    if filters.is_empty() {
        return String::new();
    }

    let conditions = filters
        .iter()
        .map(|filter| {
            format!(
                "LOWER(COALESCE({}, '')) LIKE ?",
                quoted_identifier(&filter.column)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");

    format!(" WHERE {conditions}")
}

fn filter_params(filters: &[ColumnFilter]) -> Vec<String> {
    filters
        .iter()
        .map(|filter| format!("%{}%", filter.value.to_lowercase()))
        .collect()
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
    let where_clause = build_where_clause(&active_filters);
    let filter_values = filter_params(&active_filters);
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
            values.push(value_ref_to_string(value));
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

fn empty_stats(column_count: usize) -> TableStats {
    TableStats {
        column_count,
        columns_with_empty: 0,
        empty_cells: 0,
        quality: Vec::new(),
    }
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
    columns: Vec<String>,
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
    let where_clause = build_where_clause(&active_filters);
    let filter_values = filter_params(&active_filters);
    let (order_clause, safe_sort_column, safe_sort_direction) =
        build_order_clause(sort_column, sort_direction, &columns);
    let selected_columns = selected_columns(&columns, &visible_columns);
    let projection = projection_sql(&selected_columns);
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
        "SELECT {projection} FROM ({source_sql}) AS source_query{where_clause}{order_clause} LIMIT ? OFFSET ?"
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

    while let Some(row) = query
        .next()
        .map_err(|error| format!("Nao foi possivel ler uma linha: {error}"))?
    {
        let mut values = Vec::with_capacity(selected_columns.len());

        for index in 0..selected_columns.len() {
            let value = row
                .get_ref(index)
                .map_err(|error| format!("Nao foi possivel ler a coluna {}: {error}", index + 1))?;
            values.push(value_ref_to_string(value));
        }

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

    let column_count = columns.len();

    Ok(TableWindow {
        columns,
        rows,
        total_rows,
        offset: safe_offset,
        limit: safe_limit,
        has_more,
        next_offset: has_more.then_some(next_offset),
        sort_column: safe_sort_column,
        sort_direction: safe_sort_direction,
        filters: active_filters,
        stats: empty_stats(column_count),
        performance,
    })
}

fn import_xlsx_blocking(
    app: AppHandle,
    path: String,
    workspace_id: String,
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
        let sheet_name = first_xlsx_sheet_name_from_workbook_xml(&file_path)
            .unwrap_or_else(|| "Primeira planilha".to_string());
        performance.data_preparation += preparation_start.elapsed();

        let connection = open_database(&app)?;
        ensure_workspace_exists(&connection, &workspace_id)?;

        let duckdb_xlsx_start = Instant::now();
        try_import_xlsx_direct_without_preopen(&connection, &file_path, &table_name)?;
        let duckdb_xlsx = duckdb_xlsx_start.elapsed();
        performance.duckdb += duckdb_xlsx;
        performance.duckdb_detail.xlsx_import += duckdb_xlsx;

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
            &file_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
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
            file_name,
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
        .first()
        .cloned()
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
            &file_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
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
            file_name,
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
                        &file_name,
                        &sheet_name,
                        &table_name,
                        row_count,
                        columns.len(),
                        &imported_at,
                        Some(import_duration_ms),
                        None,
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
                        file_name,
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
            &file_name,
            &sheet_name,
            &table_name,
            row_count,
            columns.len(),
            &imported_at,
            Some(import_duration_ms),
            None,
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
            file_name,
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
        &file_name,
        &sheet_name,
        &table_name,
        row_count,
        columns.len(),
        &imported_at,
        Some(import_duration_ms),
        None,
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
        file_name,
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
        "xlsx" | "xlsm" => import_xlsx_blocking(app, path, workspace_id),
        _ => Err("Use arquivos .xlsx, .xlsm ou .csv.".to_string()),
    }
}

#[tauri::command]
async fn import_document(
    app: AppHandle,
    path: String,
    workspace_id: Option<String>,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || import_document_blocking(app, path, workspace_id))
        .await
        .map_err(|error| format!("A importacao foi interrompida: {error}"))?
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
fn delete_document(app: AppHandle, document_id: String) -> Result<(), String> {
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
        .execute(
            &format!(
                "ALTER TABLE {} RENAME COLUMN {} TO {}",
                table_sql(&table_name),
                quoted_identifier(old_column),
                quoted_identifier(new_column)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel renomear a coluna: {error}"))?;

    get_columns(&connection, &table_name)
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
    get_window_from_source(
        &connection,
        &format!("SELECT * FROM {}", table_sql(&table_name)),
        columns,
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
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<TablePage, String> {
    let sql = validate_read_query(&query)?;
    let connection = open_database(&app)?;
    let columns = get_source_columns(&connection, &sql)?;
    get_page_from_source(
        &connection,
        &sql,
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
    offset: usize,
    limit: usize,
    filters: Vec<ColumnFilter>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
    visible_columns: Vec<String>,
) -> Result<TableWindow, String> {
    let sql = validate_read_query(&query)?;
    let connection = open_database(&app)?;
    let columns = get_source_columns(&connection, &sql)?;
    get_window_from_source(
        &connection,
        &sql,
        columns,
        offset,
        limit,
        filters,
        sort_column,
        sort_direction,
        visible_columns,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            create_workspace,
            update_workspace,
            import_document,
            list_documents,
            delete_document,
            rename_document,
            rename_document_column,
            export_document,
            get_table_page,
            get_sql_page,
            get_table_window,
            get_sql_window
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
}
