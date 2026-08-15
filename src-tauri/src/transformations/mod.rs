use std::time::Instant;

use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::date::excel_serial::{
    duckdb_excel_serial_date_expression, duckdb_excel_serial_valid_condition,
};

pub const TRANSFORMATIONS_TABLE: &str = "document_transformations";
pub const TRANSFORMATION_DELTAS_TABLE: &str = "document_transformation_deltas";

#[derive(Debug, Deserialize)]
pub struct Transformation {
    #[serde(rename = "type")]
    pub transformation_type: String,
    pub column: String,
    #[serde(default)]
    pub configuration: Value,
}

#[derive(Debug, Serialize)]
pub struct TransformationPreview {
    pub affected_rows: i64,
    pub unchanged_rows: i64,
    pub failed_rows: i64,
    pub total_rows: i64,
    pub samples: Vec<TransformationSample>,
    pub performance: TransformationPerformance,
}

#[derive(Debug, Serialize)]
pub struct TransformationSample {
    pub original: Option<String>,
    pub transformed: Option<String>,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct AppliedTransformation {
    pub id: String,
    pub affected_rows: i64,
    pub failed_rows: i64,
    pub performance: TransformationPerformance,
}

#[derive(Debug, Serialize)]
pub struct TransformationPerformance {
    pub duckdb_ms: u128,
    pub history_ms: u128,
    pub total_ms: u128,
}

struct TransformationSql {
    expression: String,
    failed_condition: String,
}

pub fn init_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    sequence BIGINT NOT NULL,
                    transformation_type TEXT NOT NULL,
                    column_name TEXT NOT NULL,
                    configuration_json TEXT NOT NULL,
                    affected_rows BIGINT NOT NULL,
                    failed_rows BIGINT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    duckdb_ms BIGINT NOT NULL,
                    history_ms BIGINT NOT NULL,
                    total_ms BIGINT NOT NULL
                )",
                quoted_identifier(TRANSFORMATIONS_TABLE)
            ),
            [],
        )
        .map_err(|error| {
            format!("Nao foi possivel inicializar historico de transformacoes: {error}")
        })?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    transformation_id TEXT NOT NULL,
                    row_id BIGINT NOT NULL,
                    column_name TEXT NOT NULL,
                    old_value TEXT,
                    new_value TEXT
                )",
                quoted_identifier(TRANSFORMATION_DELTAS_TABLE)
            ),
            [],
        )
        .map_err(|error| {
            format!("Nao foi possivel inicializar deltas de transformacao: {error}")
        })?;

    Ok(())
}

pub fn preview_transformation(
    connection: &Connection,
    table_name: &str,
    transformation: &Transformation,
) -> Result<TransformationPreview, String> {
    let total_start = Instant::now();
    validate_column(connection, table_name, &transformation.column)?;
    let sql = build_transformation_sql(transformation)?;
    let table = quoted_identifier(table_name);
    let column = quoted_identifier(&transformation.column);
    let duckdb_start = Instant::now();

    let total_rows: i64 = connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Nao foi possivel contar registros: {error}"))?;
    let affected_rows: i64 = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {table}
                 WHERE NOT ({column} IS NOT DISTINCT FROM ({expr}))",
                expr = sql.expression
            ),
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Nao foi possivel calcular impacto: {error}"))?;
    let failed_rows: i64 = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {table} WHERE {}",
                sql.failed_condition
            ),
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Nao foi possivel calcular falhas: {error}"))?;

    let samples = load_samples(connection, &table, &column, &sql)?;
    let duckdb_ms = duckdb_start.elapsed().as_millis();

    Ok(TransformationPreview {
        affected_rows,
        unchanged_rows: total_rows.saturating_sub(affected_rows),
        failed_rows,
        total_rows,
        samples,
        performance: TransformationPerformance {
            duckdb_ms,
            history_ms: 0,
            total_ms: total_start.elapsed().as_millis(),
        },
    })
}

pub fn apply_transformation(
    connection: &Connection,
    document_id: &str,
    table_name: &str,
    transformation: &Transformation,
    now_millis: u128,
) -> Result<AppliedTransformation, String> {
    validate_column(connection, table_name, &transformation.column)?;
    let sql = build_transformation_sql(transformation)?;
    let table = quoted_identifier(table_name);
    let column = quoted_identifier(&transformation.column);
    let temp_delta = format!("temp_delta_{}", now_millis);
    let temp_delta_sql = quoted_identifier(&temp_delta);
    let transformation_id = format!("tr_{}", now_millis);
    let created_at = now_millis.to_string();
    let configuration_json = serde_json::to_string(&transformation.configuration)
        .map_err(|error| format!("Configuracao invalida: {error}"))?;
    let total_start = Instant::now();
    let mut duckdb_ms = 0;
    let mut history_ms = 0;

    connection
        .execute("BEGIN TRANSACTION", [])
        .map_err(|error| format!("Nao foi possivel iniciar transacao: {error}"))?;
    let result = (|| {
        let duckdb_start = Instant::now();
        connection
            .execute(
                &format!(
                    "CREATE TEMP TABLE {temp_delta_sql} AS
                     SELECT rowid AS row_id, CAST({column} AS VARCHAR) AS old_value, CAST(({expr}) AS VARCHAR) AS new_value
                     FROM {table}
                     WHERE NOT ({column} IS NOT DISTINCT FROM ({expr}))",
                    expr = sql.expression
                ),
                [],
            )
            .map_err(|error| format!("Nao foi possivel preparar historico da transformacao: {error}"))?;
        duckdb_ms += duckdb_start.elapsed().as_millis();

        let affected_rows: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {temp_delta_sql}"),
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Nao foi possivel contar alteracoes: {error}"))?;
        let failed_rows: i64 = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM {table} WHERE {}",
                    sql.failed_condition
                ),
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Nao foi possivel contar falhas: {error}"))?;

        let history_start = Instant::now();
        connection
            .execute(
                &format!(
                    "INSERT INTO {} (transformation_id, row_id, column_name, old_value, new_value)
                     SELECT ?, row_id, ?, old_value, new_value FROM {temp_delta_sql}",
                    quoted_identifier(TRANSFORMATION_DELTAS_TABLE)
                ),
                params![transformation_id, transformation.column],
            )
            .map_err(|error| {
                format!("Nao foi possivel registrar deltas da transformacao: {error}")
            })?;
        history_ms += history_start.elapsed().as_millis();

        let duckdb_start = Instant::now();
        connection
            .execute(
                &format!(
                    "UPDATE {table} AS target
                     SET {column} = delta.new_value
                     FROM {temp_delta_sql} AS delta
                     WHERE target.rowid = delta.row_id"
                ),
                [],
            )
            .map_err(|error| format!("UPDATE da transformacao falhou: {error}"))?;
        duckdb_ms += duckdb_start.elapsed().as_millis();

        let sequence = next_sequence(connection, document_id)?;
        let total_ms = total_start.elapsed().as_millis();
        let history_start = Instant::now();
        connection
            .execute(
                &format!(
                    "INSERT INTO {} (
                        id, document_id, sequence, transformation_type, column_name, configuration_json,
                        affected_rows, failed_rows, status, created_at, duckdb_ms, history_ms, total_ms
                     )
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)",
                    quoted_identifier(TRANSFORMATIONS_TABLE)
                ),
                params![
                    transformation_id,
                    document_id,
                    sequence,
                    transformation.transformation_type,
                    transformation.column,
                    configuration_json,
                    affected_rows,
                    failed_rows,
                    created_at,
                    duckdb_ms.to_string(),
                    history_ms.to_string(),
                    total_ms.to_string()
                ],
            )
            .map_err(|error| format!("Nao foi possivel registrar transformacao: {error}"))?;
        history_ms += history_start.elapsed().as_millis();

        connection
            .execute(&format!("DROP TABLE {temp_delta_sql}"), [])
            .map_err(|error| format!("Nao foi possivel limpar delta temporario: {error}"))?;

        Ok(AppliedTransformation {
            id: transformation_id.clone(),
            affected_rows,
            failed_rows,
            performance: TransformationPerformance {
                duckdb_ms,
                history_ms,
                total_ms: total_start.elapsed().as_millis(),
            },
        })
    })();

    match result {
        Ok(applied) => {
            connection
                .execute("COMMIT", [])
                .map_err(|error| format!("Nao foi possivel confirmar transformacao: {error}"))?;
            eprintln!(
                "TRANSFORMATION_PERFORMANCE\n\
document_id: {document_id}\n\
transformation_type: {}\n\
affected_rows: {}\n\
duckdb_ms: {}\n\
history_ms: {}\n\
total_ms: {}",
                transformation.transformation_type,
                applied.affected_rows,
                applied.performance.duckdb_ms,
                applied.performance.history_ms,
                applied.performance.total_ms
            );
            Ok(applied)
        }
        Err(error) => {
            let _ = connection.execute("ROLLBACK", []);
            Err(error)
        }
    }
}

fn load_samples(
    connection: &Connection,
    table: &str,
    column: &str,
    sql: &TransformationSql,
) -> Result<Vec<TransformationSample>, String> {
    let mut samples = Vec::new();
    let changed_query = format!(
        "SELECT CAST({column} AS VARCHAR) AS original, CAST(({expr}) AS VARCHAR) AS transformed,
                CASE WHEN {} THEN 'failed' ELSE 'changed' END AS status
         FROM {table}
         WHERE NOT ({column} IS NOT DISTINCT FROM ({expr}))
         LIMIT 20",
        sql.failed_condition,
        expr = sql.expression
    );
    read_samples(connection, &changed_query, &mut samples)?;

    if samples
        .iter()
        .filter(|sample| sample.status == "failed")
        .count()
        < 5
    {
        let failed_query = format!(
            "SELECT CAST({column} AS VARCHAR) AS original, CAST(({expr}) AS VARCHAR) AS transformed, 'failed' AS status
             FROM {table}
             WHERE {}
             LIMIT 5",
            sql.failed_condition,
            expr = sql.expression
        );
        read_samples(connection, &failed_query, &mut samples)?;
    }

    Ok(samples)
}

fn read_samples(
    connection: &Connection,
    query: &str,
    samples: &mut Vec<TransformationSample>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(query)
        .map_err(|error| format!("Nao foi possivel preparar preview: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TransformationSample {
                original: row.get(0)?,
                transformed: row.get(1)?,
                status: row.get(2)?,
            })
        })
        .map_err(|error| format!("Nao foi possivel executar preview: {error}"))?;

    for row in rows {
        samples.push(row.map_err(|error| format!("Nao foi possivel ler amostra: {error}"))?);
    }

    Ok(())
}

fn build_transformation_sql(transformation: &Transformation) -> Result<TransformationSql, String> {
    let column = quoted_identifier(&transformation.column);
    let value = format!("CAST({column} AS VARCHAR)");
    let empty = format!("({column} IS NULL OR TRIM({value}) = '')");
    let never = "FALSE".to_string();
    let expression = match transformation.transformation_type.as_str() {
        "trim" => format!("TRIM({value})"),
        "uppercase" => format!("UPPER({value})"),
        "lowercase" => format!("LOWER({value})"),
        "replace" => {
            let find = config_string(&transformation.configuration, "find")?;
            let replacement = config_string(&transformation.configuration, "replacement")?;
            let regex = config_bool(&transformation.configuration, "regex", false);
            if regex {
                return Err(
                    "Expressao regular ainda nao esta habilitada para substituir.".to_string(),
                );
            }
            format!(
                "REPLACE({value}, {}, {})",
                sql_string_literal(&find),
                sql_string_literal(&replacement)
            )
        }
        "pad_left" => {
            let length = config_i64(&transformation.configuration, "length")?;
            if !(1..=512).contains(&length) {
                return Err("Tamanho final deve estar entre 1 e 512.".to_string());
            }
            let character = config_string_default(&transformation.configuration, "character", "0");
            let character = character.chars().next().unwrap_or('0').to_string();
            format!(
                "LPAD({value}, {length}, {})",
                sql_string_literal(&character)
            )
        }
        "excel_serial_date" => {
            let format = output_date_format(&config_string_default(
                &transformation.configuration,
                "output_format",
                "DD/MM/YYYY",
            ))?;
            let date = duckdb_excel_serial_date_expression(&format!("TRIM({value})"));
            format!(
                "CASE WHEN {empty} THEN {column} WHEN {valid} THEN STRFTIME(({date}), {}) ELSE {column} END",
                sql_string_literal(format),
                valid = duckdb_excel_serial_valid_condition(&format!("TRIM({value})"))
            )
        }
        _ => return Err("Tipo de transformacao nao suportado.".to_string()),
    };

    let failed_condition = if transformation.transformation_type == "excel_serial_date" {
        format!(
            "NOT {empty} AND NOT ({})",
            duckdb_excel_serial_valid_condition(&format!("TRIM({value})"))
        )
    } else {
        never
    };

    Ok(TransformationSql {
        expression,
        failed_condition,
    })
}

fn validate_column(connection: &Connection, table_name: &str, column: &str) -> Result<(), String> {
    if column.trim().is_empty() || column == crate::VALTRON_ROW_ID_COLUMN {
        return Err("Coluna invalida para transformacao.".to_string());
    }

    let exists: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0
             FROM information_schema.columns
             WHERE table_name = ? AND column_name = ?",
            params![table_name, column],
            |row| row.get(0),
        )
        .map_err(|error| format!("Nao foi possivel validar coluna: {error}"))?;

    if !exists {
        return Err("Coluna nao existe no documento selecionado.".to_string());
    }

    Ok(())
}

fn next_sequence(connection: &Connection, document_id: &str) -> Result<i64, String> {
    let current: Option<i64> = connection
        .query_row(
            &format!(
                "SELECT MAX(sequence) FROM {} WHERE document_id = ?",
                quoted_identifier(TRANSFORMATIONS_TABLE)
            ),
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            format!("Nao foi possivel calcular sequencia da transformacao: {error}")
        })?;

    Ok(current.unwrap_or(0) + 1)
}

fn config_string(config: &Value, key: &str) -> Result<String, String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Configuracao obrigatoria ausente: {key}"))
}

fn config_string_default(config: &Value, key: &str, default: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn config_i64(config: &Value, key: &str) -> Result<i64, String> {
    config
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Configuracao obrigatoria ausente: {key}"))
}

fn config_bool(config: &Value, key: &str, default: bool) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn output_date_format(value: &str) -> Result<&'static str, String> {
    match value {
        "DD/MM/YYYY" => Ok("%d/%m/%Y"),
        "YYYY-MM-DD" => Ok("%Y-%m-%d"),
        "YYYY/MM/DD" => Ok("%Y/%m/%d"),
        "DD-MM-YYYY" => Ok("%d-%m-%Y"),
        _ => Err("Formato de saida de data nao suportado.".to_string()),
    }
}

fn quoted_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
