use miette::Result;
use rigg_core::{RunId, WorkflowId};
use serde_json::{Map, Value as JsonValue};

pub(super) fn parse_run_id(value: &str) -> Result<RunId> {
    value.parse().map_err(|error| miette::miette!("invalid run id `{value}`: {error}"))
}

pub(super) fn parse_workflow_id(value: &str) -> Result<WorkflowId> {
    value.parse().map_err(|error| miette::miette!("invalid workflow id `{value}`: {error}"))
}

pub(super) fn parse_inputs(values: &[String]) -> Result<JsonValue> {
    let mut map = Map::new();
    for value in values {
        let Some((key, raw_value)) = value.split_once('=') else {
            return Err(miette::miette!("invalid --input `{value}`; expected KEY=VALUE"));
        };
        let parsed = serde_json::from_str(raw_value)
            .unwrap_or_else(|_| JsonValue::String(raw_value.to_owned()));
        map.insert(key.to_owned(), parsed);
    }
    Ok(JsonValue::Object(map))
}

#[cfg(test)]
mod tests {
    use super::parse_run_id;
    use miette::Result;

    #[test]
    fn parses_valid_run_id() -> Result<()> {
        let run_id = parse_run_id("019cc300-0000-7000-8000-000000000010")?;
        assert_eq!(run_id.to_string(), "019cc300-0000-7000-8000-000000000010");
        Ok(())
    }
}
