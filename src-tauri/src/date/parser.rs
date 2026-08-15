use chrono::NaiveDate;

use super::excel_serial::{
    duckdb_excel_serial_valid_condition, excel_serial_to_date, EXCEL_SERIAL_MAX, EXCEL_SERIAL_MIN,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateFormat {
    DayMonthYearSlash,
    YearMonthDaySlash,
    YearMonthDayDash,
    DayMonthYearDash,
}

impl DateFormat {
    pub fn from_config(value: &str) -> Self {
        match value {
            "YYYY/MM/DD" => Self::YearMonthDaySlash,
            "YYYY-MM-DD" => Self::YearMonthDayDash,
            "DD-MM-YYYY" => Self::DayMonthYearDash,
            _ => Self::DayMonthYearSlash,
        }
    }

    pub fn chrono_pattern(self) -> &'static str {
        match self {
            Self::DayMonthYearSlash => "%d/%m/%Y",
            Self::YearMonthDaySlash => "%Y/%m/%d",
            Self::YearMonthDayDash => "%Y-%m-%d",
            Self::DayMonthYearDash => "%d-%m-%Y",
        }
    }

    pub fn duckdb_pattern(self) -> &'static str {
        self.chrono_pattern()
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateSource {
    Formatted,
    ExcelSerial,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedDate {
    pub date: NaiveDate,
    pub source: DateSource,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DateParseResult {
    Empty,
    Invalid,
    Parsed(ParsedDate),
}

#[allow(dead_code)]
pub fn parse_date_value(
    value: &str,
    format: DateFormat,
    accept_excel_serial: bool,
) -> DateParseResult {
    let value = value.trim();
    if value.is_empty() {
        return DateParseResult::Empty;
    }

    if let Ok(date) = NaiveDate::parse_from_str(value, format.chrono_pattern()) {
        return DateParseResult::Parsed(ParsedDate {
            date,
            source: DateSource::Formatted,
        });
    }

    if !accept_excel_serial || !is_excel_serial_candidate(value) {
        return DateParseResult::Invalid;
    }

    match value.parse::<i64>().ok().and_then(excel_serial_to_date) {
        Some(date) => DateParseResult::Parsed(ParsedDate {
            date,
            source: DateSource::ExcelSerial,
        }),
        None => DateParseResult::Invalid,
    }
}

pub fn duckdb_date_value_valid_condition(
    value: &str,
    _format: DateFormat,
    accept_excel_serial: bool,
) -> String {
    let formatted = format!("TRY_STRPTIME({value}, ?) IS NOT NULL");
    if accept_excel_serial {
        format!(
            "({formatted} OR (TRY_STRPTIME({value}, ?) IS NULL AND {excel_serial}))",
            excel_serial = duckdb_excel_serial_valid_condition(value)
        )
    } else {
        formatted
    }
}

#[allow(dead_code)]
fn is_excel_serial_candidate(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= EXCEL_SERIAL_MAX.to_string().len()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<i64>()
            .is_ok_and(|serial| (EXCEL_SERIAL_MIN..=EXCEL_SERIAL_MAX).contains(&serial))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    #[test]
    fn parses_textual_date_before_serial() {
        assert_eq!(
            parse_date_value("1992/02/05", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Parsed(ParsedDate {
                date: date(1992, 2, 5),
                source: DateSource::Formatted
            })
        );
    }

    #[test]
    fn parses_excel_serial_only_when_enabled() {
        assert_eq!(
            parse_date_value("33639", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Parsed(ParsedDate {
                date: date(1992, 2, 5),
                source: DateSource::ExcelSerial
            })
        );
        assert_eq!(
            parse_date_value("33639", DateFormat::YearMonthDaySlash, false),
            DateParseResult::Invalid
        );
    }

    #[test]
    fn treats_empty_values_as_empty() {
        assert_eq!(
            parse_date_value("", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Empty
        );
        assert_eq!(
            parse_date_value("   ", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Empty
        );
    }

    #[test]
    fn rejects_invalid_and_non_integer_serials() {
        assert_eq!(
            parse_date_value("ABC", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Invalid
        );
        assert_eq!(
            parse_date_value("12345678901", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Invalid
        );
        assert_eq!(
            parse_date_value("33639.5", DateFormat::YearMonthDaySlash, true),
            DateParseResult::Invalid
        );
    }
}
