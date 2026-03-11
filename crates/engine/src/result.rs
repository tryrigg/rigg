use super::{EngineError, ExecutorError, ResultError, ValidationError};
use crate::ids::StepId;
use crate::state::CapturedValue;
use crate::workflow::{
    ActionKind, ActionNode, InputErrorKind, InputValidationError, OutputSchema, ResultContract,
    ResultValidationError, ShellOutput, ValidatedNode, ValidatedWorkflow,
};
use serde_json::{Map as JsonMap, Value as JsonValue};

pub(super) fn finalize_result(
    node: &ValidatedNode,
    result: Option<&CapturedValue>,
) -> Result<Option<CapturedValue>, EngineError> {
    let action = match &node.kind {
        crate::workflow::NodeKind::Action(action) => action,
        _ => unreachable!("slice 5 only executes action nodes"),
    };
    if action.result_contract.result_schema().is_some() && result.is_none() {
        return Err(ResultError::MissingStructuredResult { node: node_label(node) }.into());
    }
    let Some(result) = result else {
        return Ok(None);
    };

    let result = normalize_result(action, result)?;
    if let Some(schema) = action.result_contract.result_schema() {
        let value = result.as_json();
        validate_against_schema(&node_label(node), schema, &value)?;
        Ok(Some(CapturedValue::Json(value)))
    } else {
        Ok(Some(result))
    }
}

pub(super) fn normalize_invocation_inputs(
    workflow: &ValidatedWorkflow,
    inputs: &JsonValue,
) -> Result<JsonValue, EngineError> {
    let object = inputs.as_object().ok_or(ValidationError::ExpectedObject)?;

    for key in object.keys() {
        if !workflow.inputs.contains_key(key.as_str()) {
            return Err(ValidationError::UnexpectedInput { input: key.clone() }.into());
        }
    }

    let mut normalized = JsonMap::new();
    for (key, schema) in &workflow.inputs {
        let value = object
            .get(key)
            .or_else(|| schema.default())
            .ok_or_else(|| ValidationError::MissingInput { input: key.clone() })?;
        normalized.insert(
            key.clone(),
            schema
                .validate_and_normalize(Some(&format!("inputs.{key}")), value)
                .map_err(map_input_validation_error)?,
        );
    }

    Ok(JsonValue::Object(normalized))
}

fn normalize_result(
    action: &ActionNode,
    result: &CapturedValue,
) -> Result<CapturedValue, EngineError> {
    match (&action.action, &action.result_contract, result) {
        (ActionKind::Shell(shell), ResultContract::Json { .. }, CapturedValue::Text(text))
            if matches!(shell.result_mode, ShellOutput::Json) =>
        {
            parse_command_json_output(text)
        }
        _ => Ok(result.clone()),
    }
}

fn parse_command_json_output(text: &str) -> Result<CapturedValue, EngineError> {
    serde_json::from_str(text.trim()).map(CapturedValue::Json).map_err(|source| {
        EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "command", source })
    })
}

fn validate_against_schema(
    node_label: &str,
    schema: &OutputSchema,
    value: &JsonValue,
) -> Result<(), EngineError> {
    schema.validate_value(None, value).map_err(|error| match error {
        ResultValidationError::MissingRequiredField { field } => {
            ResultError::MissingRequiredField { node: node_label.to_owned(), field }.into()
        }
        ResultValidationError::TypeMismatch { field, expected } => {
            ResultError::ResultTypeMismatch { node: node_label.to_owned(), output: field, expected }
                .into()
        }
    })
}

fn node_label(node: &ValidatedNode) -> String {
    node.user_id.as_ref().map(StepId::to_string).unwrap_or_else(|| node.path.to_string())
}

fn map_input_validation_error(error: InputValidationError) -> EngineError {
    let path = error.path;
    match error.kind {
        InputErrorKind::TypeMismatch { expected } => {
            ValidationError::TypeMismatch { path, expected }.into()
        }
        InputErrorKind::EnumViolation => ValidationError::EnumViolation { path }.into(),
        InputErrorKind::MinimumViolation { minimum } => {
            ValidationError::RangeViolation { path, constraint: ">=", limit: minimum }.into()
        }
        InputErrorKind::MaximumViolation { maximum } => {
            ValidationError::RangeViolation { path, constraint: "<=", limit: maximum }.into()
        }
        InputErrorKind::MinLengthViolation { min_length } => {
            ValidationError::LengthViolation { path, constraint: "length >=", limit: min_length }
                .into()
        }
        InputErrorKind::MaxLengthViolation { max_length } => {
            ValidationError::LengthViolation { path, constraint: "length <=", limit: max_length }
                .into()
        }
        InputErrorKind::PatternViolation { pattern } => {
            ValidationError::PatternViolation { path, pattern }.into()
        }
        InputErrorKind::MissingRequiredProperty => {
            ValidationError::MissingRequiredField { path }.into()
        }
        InputErrorKind::MinItemsViolation { min_items } => {
            ValidationError::ItemCountViolation { path, constraint: "at least", limit: min_items }
                .into()
        }
        InputErrorKind::MaxItemsViolation { max_items } => {
            ValidationError::ItemCountViolation { path, constraint: "at most", limit: max_items }
                .into()
        }
    }
}
