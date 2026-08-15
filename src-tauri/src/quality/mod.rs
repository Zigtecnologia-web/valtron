use std::time::Instant;

use duckdb::{params, params_from_iter, Connection, ToSql};
use serde::{Deserialize, Serialize};

use crate::{
    date::parser::{duckdb_date_value_valid_condition, DateFormat},
    now_millis, quoted_identifier, table_sql,
};

pub const QUALITY_RULES_TABLE: &str = "data_quality_rules";

#[derive(Clone, Deserialize, Serialize)]
pub struct QualityRule {
    pub id: String,
    pub document_id: String,
    pub column_name: String,
    pub rule_type: String,
    pub name: String,
    pub configuration_json: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize)]
pub struct QualityRuleInput {
    pub column_name: String,
    pub rule_type: String,
    pub name: String,
    pub configuration_json: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Clone, Serialize)]
pub struct QualityRuleResult {
    pub rule_id: String,
    pub rule_name: String,
    pub rule_type: String,
    pub total_rows: usize,
    pub evaluated_rows: usize,
    pub violation_count: usize,
    pub violation_percentage: f64,
    pub status: String,
    pub error: Option<String>,
    pub performance: QualityRulePerformance,
}

#[derive(Clone, Serialize)]
pub struct QualityRulePerformance {
    pub duckdb_ms: u128,
    pub processing_ms: u128,
    pub total_ms: u128,
    pub cache_hit: bool,
}

#[derive(Clone, Serialize)]
pub struct QualityValidationSummary {
    pub document_id: String,
    pub column_name: String,
    pub total_rows: usize,
    pub problem_rows: usize,
    pub valid_rows: usize,
    pub score: f64,
    pub results: Vec<QualityRuleResult>,
    pub performance: QualityRulePerformance,
}

#[derive(Clone)]
pub struct ConditionSql {
    pub sql: String,
    pub params: Vec<String>,
}

#[derive(Deserialize)]
#[serde(default)]
struct RuleConfig {
    mode: String,
    value: Option<i64>,
    min: Option<f64>,
    max: Option<f64>,
    inclusive: bool,
    values: Vec<String>,
    ignore_case: bool,
    pattern: String,
    format: String,
    accept_excel_serial: bool,
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self {
            mode: "exact".to_string(),
            value: None,
            min: None,
            max: None,
            inclusive: true,
            values: Vec::new(),
            ignore_case: false,
            pattern: String::new(),
            format: "DD/MM/YYYY".to_string(),
            accept_excel_serial: false,
        }
    }
}

fn default_enabled() -> bool {
    true
}

pub fn init_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    column_name TEXT NOT NULL,
                    rule_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    configuration_json TEXT NOT NULL,
                    enabled BOOLEAN NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            [],
        )
        .map_err(|error| format!("Nao foi possivel inicializar regras de qualidade: {error}"))?;

    Ok(())
}

pub fn list_rules(
    connection: &Connection,
    document_id: &str,
    column_name: Option<&str>,
) -> Result<Vec<QualityRule>, String> {
    let mut sql = format!(
        "SELECT id, document_id, column_name, rule_type, name, configuration_json, enabled, created_at, updated_at
         FROM {}
         WHERE document_id = ?",
        quoted_identifier(QUALITY_RULES_TABLE)
    );
    let mut values = vec![document_id.to_string()];

    if let Some(column) = column_name {
        sql.push_str(" AND column_name = ?");
        values.push(column.to_string());
    }

    sql.push_str(" ORDER BY CAST(created_at AS BIGINT), name");

    let refs = values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Nao foi possivel preparar a listagem de regras: {error}"))?;

    statement
        .query_map(params_from_iter(refs), |row| {
            Ok(QualityRule {
                id: row.get(0)?,
                document_id: row.get(1)?,
                column_name: row.get(2)?,
                rule_type: row.get(3)?,
                name: row.get(4)?,
                configuration_json: row.get(5)?,
                enabled: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("Nao foi possivel consultar regras de qualidade: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Nao foi possivel processar regras de qualidade: {error}"))
}

pub fn create_rule(
    connection: &Connection,
    document_id: &str,
    input: QualityRuleInput,
) -> Result<QualityRule, String> {
    validate_rule_input(&input)?;
    let id = connection
        .query_row("SELECT CAST(uuid() AS VARCHAR)", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Nao foi possivel gerar o ID da regra: {error}"))?;
    let now = now_millis()?.to_string();

    connection
        .execute(
            &format!(
                "INSERT INTO {} (id, document_id, column_name, rule_type, name, configuration_json, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![
                id,
                document_id,
                input.column_name,
                input.rule_type,
                input.name,
                input.configuration_json,
                input.enabled,
                now,
                now
            ],
        )
        .map_err(|error| format!("Nao foi possivel salvar a regra de qualidade: {error}"))?;

    get_rule(connection, &id)
}

pub fn update_rule(
    connection: &Connection,
    rule_id: &str,
    input: QualityRuleInput,
) -> Result<QualityRule, String> {
    validate_rule_input(&input)?;
    let now = now_millis()?.to_string();
    let updated = connection
        .execute(
            &format!(
                "UPDATE {}
                 SET column_name = ?, rule_type = ?, name = ?, configuration_json = ?, enabled = ?, updated_at = ?
                 WHERE id = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![
                input.column_name,
                input.rule_type,
                input.name,
                input.configuration_json,
                input.enabled,
                now,
                rule_id
            ],
        )
        .map_err(|error| format!("Nao foi possivel atualizar a regra de qualidade: {error}"))?;

    if updated == 0 {
        return Err("Regra de qualidade nao encontrada.".to_string());
    }

    get_rule(connection, rule_id)
}

pub fn delete_rule(connection: &Connection, rule_id: &str) -> Result<Option<String>, String> {
    let document_id = connection
        .query_row(
            &format!(
                "SELECT document_id FROM {} WHERE id = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![rule_id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let deleted = connection
        .execute(
            &format!(
                "DELETE FROM {} WHERE id = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![rule_id],
        )
        .map_err(|error| format!("Nao foi possivel excluir a regra de qualidade: {error}"))?;

    if deleted == 0 {
        return Err("Regra de qualidade nao encontrada.".to_string());
    }

    Ok(document_id)
}

pub fn delete_document_rules(connection: &Connection, document_id: &str) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "DELETE FROM {} WHERE document_id = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![document_id],
        )
        .map_err(|error| format!("Nao foi possivel remover regras do documento: {error}"))?;
    Ok(())
}

pub fn rename_column_rules(
    connection: &Connection,
    document_id: &str,
    old_column: &str,
    new_column: &str,
) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "UPDATE {} SET column_name = ?, updated_at = ? WHERE document_id = ? AND column_name = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![new_column, now_millis()?.to_string(), document_id, old_column],
        )
        .map_err(|error| format!("Nao foi possivel atualizar regras da coluna renomeada: {error}"))?;
    Ok(())
}

pub fn get_rule(connection: &Connection, rule_id: &str) -> Result<QualityRule, String> {
    connection
        .query_row(
            &format!(
                "SELECT id, document_id, column_name, rule_type, name, configuration_json, enabled, created_at, updated_at
                 FROM {} WHERE id = ?",
                quoted_identifier(QUALITY_RULES_TABLE)
            ),
            params![rule_id],
            |row| {
                Ok(QualityRule {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    column_name: row.get(2)?,
                    rule_type: row.get(3)?,
                    name: row.get(4)?,
                    configuration_json: row.get(5)?,
                    enabled: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .map_err(|error| format!("Regra de qualidade nao encontrada: {error}"))
}

pub fn validate_rules(
    connection: &Connection,
    document_id: &str,
    table_name: &str,
    column_name: &str,
    rules: &[QualityRule],
    cache_hit: bool,
) -> Result<QualityValidationSummary, String> {
    let total_start = Instant::now();
    let duckdb_start = Instant::now();
    let total_rows = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", table_sql(table_name)),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Nao foi possivel contar registros para qualidade: {error}"))?
        .max(0) as usize;

    let mut results = Vec::new();
    let mut enabled_conditions = Vec::new();
    let mut enabled_params = Vec::new();

    for rule in rules.iter().filter(|rule| rule.enabled) {
        let rule_start = Instant::now();
        match build_condition_for_rule(rule, table_name, None) {
            Ok(condition) => {
                let violation_count = count_condition(connection, table_name, &condition)?;
                enabled_conditions.push(condition.sql);
                enabled_params.extend(condition.params);
                results.push(QualityRuleResult {
                    rule_id: rule.id.clone(),
                    rule_name: rule.name.clone(),
                    rule_type: rule.rule_type.clone(),
                    total_rows,
                    evaluated_rows: if condition_evaluates_filled(rule) {
                        count_filled(connection, table_name, &rule.column_name)?
                    } else {
                        total_rows
                    },
                    violation_count,
                    violation_percentage: percentage(violation_count, total_rows),
                    status: "ok".to_string(),
                    error: None,
                    performance: QualityRulePerformance {
                        duckdb_ms: rule_start.elapsed().as_millis(),
                        processing_ms: 0,
                        total_ms: rule_start.elapsed().as_millis(),
                        cache_hit: false,
                    },
                });
            }
            Err(error) => results.push(QualityRuleResult {
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                rule_type: rule.rule_type.clone(),
                total_rows,
                evaluated_rows: 0,
                violation_count: 0,
                violation_percentage: 0.0,
                status: "error".to_string(),
                error: Some(error),
                performance: QualityRulePerformance {
                    duckdb_ms: 0,
                    processing_ms: 0,
                    total_ms: rule_start.elapsed().as_millis(),
                    cache_hit: false,
                },
            }),
        }
    }

    for rule in rules.iter().filter(|rule| !rule.enabled) {
        results.push(QualityRuleResult {
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            rule_type: rule.rule_type.clone(),
            total_rows,
            evaluated_rows: 0,
            violation_count: 0,
            violation_percentage: 0.0,
            status: "disabled".to_string(),
            error: None,
            performance: QualityRulePerformance {
                duckdb_ms: 0,
                processing_ms: 0,
                total_ms: 0,
                cache_hit,
            },
        });
    }

    let problem_rows = if enabled_conditions.is_empty() {
        0
    } else {
        let condition = ConditionSql {
            sql: enabled_conditions
                .into_iter()
                .map(|sql| format!("({sql})"))
                .collect::<Vec<_>>()
                .join(" OR "),
            params: enabled_params,
        };
        count_condition(connection, table_name, &condition)?
    };
    let duckdb_elapsed = duckdb_start.elapsed();
    let valid_rows = total_rows.saturating_sub(problem_rows);
    let performance = QualityRulePerformance {
        duckdb_ms: duckdb_elapsed.as_millis(),
        processing_ms: 0,
        total_ms: total_start.elapsed().as_millis(),
        cache_hit,
    };

    eprintln!(
        "QUALITY_PERFORMANCE\n\
document_id: {document_id}\n\
column: {column_name}\n\
rules_count: {}\n\
row_count: {total_rows}\n\
duckdb_ms: {}\n\
processing_ms: {}\n\
total_ms: {}\n\
cache_hit: {}",
        rules.len(),
        performance.duckdb_ms,
        performance.processing_ms,
        performance.total_ms,
        performance.cache_hit
    );

    Ok(QualityValidationSummary {
        document_id: document_id.to_string(),
        column_name: column_name.to_string(),
        total_rows,
        problem_rows,
        valid_rows,
        score: percentage(valid_rows, total_rows),
        results,
        performance,
    })
}

pub fn build_condition_for_rule(
    rule: &QualityRule,
    table_name: &str,
    source_alias: Option<&str>,
) -> Result<ConditionSql, String> {
    let config: RuleConfig = serde_json::from_str(&rule.configuration_json)
        .map_err(|error| format!("Configuracao da regra invalida: {error}"))?;
    let column = match source_alias {
        Some(alias) => format!(
            "{}.{}",
            quoted_identifier(alias),
            quoted_identifier(&rule.column_name)
        ),
        None => quoted_identifier(&rule.column_name),
    };
    let value = format!("TRIM(CAST({column} AS VARCHAR))");
    let filled = format!("({column} IS NOT NULL AND {value} <> '')");

    match rule.rule_type.as_str() {
        "required" => Ok(ConditionSql {
            sql: format!("({column} IS NULL OR {value} = '')"),
            params: Vec::new(),
        }),
        "unique" => Ok(ConditionSql {
            sql: format!(
                "{filled} AND {value} IN (
                    SELECT duplicated_value
                    FROM (
                        SELECT TRIM(CAST({} AS VARCHAR)) AS duplicated_value
                        FROM {}
                        WHERE {} IS NOT NULL AND TRIM(CAST({} AS VARCHAR)) <> ''
                        GROUP BY duplicated_value
                        HAVING COUNT(*) > 1
                    ) AS duplicated_values
                )",
                quoted_identifier(&rule.column_name),
                table_sql(table_name),
                quoted_identifier(&rule.column_name),
                quoted_identifier(&rule.column_name)
            ),
            params: Vec::new(),
        }),
        "length" => length_condition(config, value, filled),
        "numeric" => Ok(ConditionSql {
            sql: format!("{filled} AND TRY_CAST(REPLACE({value}, ',', '.') AS DOUBLE) IS NULL"),
            params: Vec::new(),
        }),
        "numeric_range" => numeric_range_condition(config, value, filled),
        "allowed_values" => allowed_values_condition(config, value, filled),
        "regex" => {
            if config.pattern.trim().is_empty() {
                return Err("Informe a expressao regular.".to_string());
            }
            Ok(ConditionSql {
                sql: format!("{filled} AND NOT regexp_matches({value}, ?)"),
                params: vec![config.pattern],
            })
        }
        "date" => date_condition(config, value, filled),
        "email" => Ok(ConditionSql {
            sql: format!("{filled} AND NOT regexp_matches({value}, ?)"),
            params: vec![
                r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$".to_string(),
            ],
        }),
        "cpf" => cpf_condition(column, value, filled),
        _ => Err("Tipo de regra de qualidade desconhecido.".to_string()),
    }
}

fn validate_rule_input(input: &QualityRuleInput) -> Result<(), String> {
    if input.column_name.trim().is_empty() {
        return Err("Coluna da regra nao informada.".to_string());
    }
    if input.name.trim().is_empty() {
        return Err("Nome da regra nao informado.".to_string());
    }
    serde_json::from_str::<RuleConfig>(&input.configuration_json)
        .map_err(|error| format!("Configuracao da regra invalida: {error}"))?;
    Ok(())
}

fn condition_evaluates_filled(rule: &QualityRule) -> bool {
    !matches!(rule.rule_type.as_str(), "required")
}

fn count_filled(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<usize, String> {
    let column = quoted_identifier(column_name);
    connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE {column} IS NOT NULL AND TRIM(CAST({column} AS VARCHAR)) <> ''",
                table_sql(table_name)
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("Nao foi possivel contar linhas avaliadas: {error}"))
}

fn count_condition(
    connection: &Connection,
    table_name: &str,
    condition: &ConditionSql,
) -> Result<usize, String> {
    let refs = condition
        .params
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE {}",
                table_sql(table_name),
                condition.sql
            ),
            params_from_iter(refs),
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("Nao foi possivel contar violacoes: {error}"))
}

fn percentage(part: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (part as f64 / total as f64) * 100.0
    }
}

fn length_condition(
    config: RuleConfig,
    value: String,
    filled: String,
) -> Result<ConditionSql, String> {
    let length = format!("LENGTH({value})");
    let sql = match config.mode.as_str() {
        "min" => format!(
            "{length} < {}",
            config.value.ok_or("Informe o comprimento minimo.")?
        ),
        "max" => format!(
            "{length} > {}",
            config.value.ok_or("Informe o comprimento maximo.")?
        ),
        "between" => format!(
            "({length} < {} OR {length} > {})",
            config.min.ok_or("Informe o comprimento minimo.")?,
            config.max.ok_or("Informe o comprimento maximo.")?
        ),
        _ => format!(
            "{length} <> {}",
            config.value.ok_or("Informe o comprimento esperado.")?
        ),
    };
    Ok(ConditionSql {
        sql: format!("{filled} AND {sql}"),
        params: Vec::new(),
    })
}

fn numeric_range_condition(
    config: RuleConfig,
    value: String,
    filled: String,
) -> Result<ConditionSql, String> {
    let number = format!("TRY_CAST(REPLACE({value}, ',', '.') AS DOUBLE)");
    let min = config.min.ok_or("Informe o limite minimo.")?;
    let max = config.max.ok_or("Informe o limite maximo.")?;
    let comparison = if config.inclusive {
        format!("({number} IS NULL OR {number} < {min} OR {number} > {max})")
    } else {
        format!("({number} IS NULL OR {number} <= {min} OR {number} >= {max})")
    };

    Ok(ConditionSql {
        sql: format!("{filled} AND {comparison}"),
        params: Vec::new(),
    })
}

fn allowed_values_condition(
    config: RuleConfig,
    value: String,
    filled: String,
) -> Result<ConditionSql, String> {
    let values = config
        .values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    if values.is_empty() {
        return Err("Informe ao menos um valor permitido.".to_string());
    }

    let placeholders = values.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let expression = if config.ignore_case {
        format!("LOWER({value})")
    } else {
        value
    };
    let params = if config.ignore_case {
        values
            .into_iter()
            .map(|value| value.to_lowercase())
            .collect()
    } else {
        values
    };

    Ok(ConditionSql {
        sql: format!("{filled} AND {expression} NOT IN ({placeholders})"),
        params,
    })
}

fn date_condition(
    config: RuleConfig,
    value: String,
    filled: String,
) -> Result<ConditionSql, String> {
    let format = DateFormat::from_config(&config.format);
    let accepted = duckdb_date_value_valid_condition(&value, format, config.accept_excel_serial);
    let params = if config.accept_excel_serial {
        vec![
            format.duckdb_pattern().to_string(),
            format.duckdb_pattern().to_string(),
        ]
    } else {
        vec![format.duckdb_pattern().to_string()]
    };

    Ok(ConditionSql {
        sql: format!("{filled} AND NOT ({accepted})"),
        params,
    })
}

fn cpf_condition(column: String, value: String, filled: String) -> Result<ConditionSql, String> {
    let digits = format!("regexp_replace({value}, '[^0-9]', '', 'g')");
    let digit = |index: usize| format!("CAST(SUBSTR({digits}, {index}, 1) AS INTEGER)");
    let sum1 = (1..=9)
        .map(|index| format!("{} * {}", digit(index), 11 - index))
        .collect::<Vec<_>>()
        .join(" + ");
    let sum2 = (1..=10)
        .map(|index| format!("{} * {}", digit(index), 12 - index))
        .collect::<Vec<_>>()
        .join(" + ");
    let check1 =
        format!("CASE WHEN (({sum1}) * 10) % 11 = 10 THEN 0 ELSE (({sum1}) * 10) % 11 END");
    let check2 =
        format!("CASE WHEN (({sum2}) * 10) % 11 = 10 THEN 0 ELSE (({sum2}) * 10) % 11 END");
    let repeated = [
        "00000000000",
        "11111111111",
        "22222222222",
        "33333333333",
        "44444444444",
        "55555555555",
        "66666666666",
        "77777777777",
        "88888888888",
        "99999999999",
    ]
    .iter()
    .map(|value| format!("'{value}'"))
    .collect::<Vec<_>>()
    .join(", ");
    let invalid = format!(
        "LENGTH({digits}) <> 11
         OR {digits} IN ({repeated})
         OR {check1} <> {}
         OR {check2} <> {}",
        digit(10),
        digit(11)
    );

    Ok(ConditionSql {
        sql: format!("{column} IS NOT NULL AND {filled} AND ({invalid})"),
        params: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date_rule(config: &str) -> QualityRule {
        QualityRule {
            id: "rule-date".to_string(),
            document_id: "doc".to_string(),
            column_name: "DATA".to_string(),
            rule_type: "date".to_string(),
            name: "Data valida".to_string(),
            configuration_json: config.to_string(),
            enabled: true,
            created_at: "0".to_string(),
            updated_at: "0".to_string(),
        }
    }

    fn count_violations_for_values(config: &str, values: &[&str]) -> usize {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE data_values (DATA VARCHAR)", [])
            .unwrap();
        for value in values {
            connection
                .execute("INSERT INTO data_values VALUES (?)", params![value])
                .unwrap();
        }
        let rule = date_rule(config);
        let condition = build_condition_for_rule(&rule, "data_values", None).unwrap();
        count_condition(&connection, "data_values", &condition).unwrap()
    }

    #[test]
    fn old_date_rule_without_excel_serial_field_keeps_serial_invalid() {
        let violations =
            count_violations_for_values(r#"{"format":"YYYY/MM/DD"}"#, &["1992/02/05", "33639"]);
        assert_eq!(violations, 1);
    }

    #[test]
    fn date_rule_accepts_excel_serial_only_when_enabled() {
        let disabled = count_violations_for_values(
            r#"{"format":"YYYY/MM/DD","accept_excel_serial":false}"#,
            &["33639"],
        );
        let enabled = count_violations_for_values(
            r#"{"format":"YYYY/MM/DD","accept_excel_serial":true}"#,
            &["33639"],
        );

        assert_eq!(disabled, 1);
        assert_eq!(enabled, 0);
    }

    #[test]
    fn date_rule_ignores_empty_values_and_rejects_decimal_serial() {
        let violations = count_violations_for_values(
            r#"{"format":"YYYY/MM/DD","accept_excel_serial":true}"#,
            &["", "   ", "33639.5", "ABC"],
        );

        assert_eq!(violations, 2);
    }
}
