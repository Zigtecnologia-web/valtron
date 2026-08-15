use chrono::{Duration, NaiveDate};

pub const EXCEL_SERIAL_MIN: i64 = 1;
pub const EXCEL_SERIAL_MAX: i64 = 73_050;

#[allow(dead_code)]
pub fn excel_serial_to_date(serial: i64) -> Option<NaiveDate> {
    if !(EXCEL_SERIAL_MIN..=EXCEL_SERIAL_MAX).contains(&serial) || serial == 60 {
        return None;
    }

    let base = NaiveDate::from_ymd_opt(1899, 12, 31)?;
    let days = if serial > 60 {
        // Excel's 1900 date system preserves the historical Lotus 1-2-3 bug:
        // serial 60 is treated as the non-existent 1900-02-29. For real dates
        // after that point, subtract one day so serial 61 maps to 1900-03-01.
        serial - 1
    } else {
        serial
    };

    base.checked_add_signed(Duration::days(days))
}

pub fn duckdb_excel_serial_valid_condition(value: &str) -> String {
    format!(
        "regexp_matches({value}, '^[0-9]+$') \
         AND TRY_CAST({value} AS BIGINT) BETWEEN {min} AND {max} \
         AND TRY_CAST({value} AS BIGINT) <> 60",
        min = EXCEL_SERIAL_MIN,
        max = EXCEL_SERIAL_MAX
    )
}

pub fn duckdb_excel_serial_date_expression(value: &str) -> String {
    let serial = format!("TRY_CAST({value} AS BIGINT)");
    format!(
        "CASE \
            WHEN {valid} THEN \
                DATE '1899-12-31' + CAST(CASE WHEN {serial} > 60 THEN {serial} - 1 ELSE {serial} END AS INTEGER) \
            ELSE NULL \
         END",
        valid = duckdb_excel_serial_valid_condition(value),
        serial = serial
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    #[test]
    fn converts_excel_1900_serials_around_historical_bug() {
        assert_eq!(excel_serial_to_date(1), Some(date(1900, 1, 1)));
        assert_eq!(excel_serial_to_date(59), Some(date(1900, 2, 28)));
        assert_eq!(excel_serial_to_date(60), None);
        assert_eq!(excel_serial_to_date(61), Some(date(1900, 3, 1)));
    }

    #[test]
    fn converts_common_excel_serial() {
        assert_eq!(excel_serial_to_date(33_639), Some(date(1992, 2, 5)));
    }

    #[test]
    fn rejects_serials_outside_internal_plausible_range() {
        assert_eq!(excel_serial_to_date(0), None);
        assert_eq!(excel_serial_to_date(EXCEL_SERIAL_MAX + 1), None);
        assert_eq!(excel_serial_to_date(12_345_678_901), None);
    }
}
