use super::{ConfigError, ExprRules, FieldSite, RunContext};
use rigg_core::{
    CompiledExpr, ExpectedType, ExprRoot, InputSchema, PathReference, ResultShape, Template,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn compile_template(
    site: FieldSite<'_>,
    field: &str,
    source: String,
    rules: ExprRules<'_>,
) -> Result<Template, ConfigError> {
    let template = Template::parse(source).map_err(|source| ConfigError::Template {
        path: site.path.to_path_buf(),
        location: site.location,
        workflow_id: site.workflow_id.to_string(),
        source: Box::new(source),
    })?;
    for expression in template.compiled_expressions() {
        validate_expr_usage(site, field, expression, rules)?;
    }
    Ok(template)
}

pub(super) fn compile_template_list(
    site: FieldSite<'_>,
    field: &str,
    sources: Vec<String>,
    rules: ExprRules<'_>,
) -> Result<Vec<Template>, ConfigError> {
    sources
        .into_iter()
        .enumerate()
        .map(|(index, source)| compile_template(site, &format!("{field}[{index}]"), source, rules))
        .collect()
}

pub(super) fn compile_wrapped_expr(
    site: FieldSite<'_>,
    field: &str,
    source: &str,
    expected: Option<ExpectedType>,
    rules: ExprRules<'_>,
) -> Result<CompiledExpr, ConfigError> {
    let trimmed = source.trim();
    let Some(inner) = trimmed.strip_prefix("${{").and_then(|value| value.strip_suffix("}}")) else {
        return Err(ConfigError::InvalidExprTemplate {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            field: field.to_owned(),
        });
    };
    let expr = CompiledExpr::compile(inner.trim().to_owned(), expected).map_err(|source| {
        ConfigError::Expr {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            source: Box::new(source),
        }
    })?;
    validate_expr_usage(site, field, &expr, rules)?;
    Ok(expr)
}

pub(super) fn infer_expr_shape(expr: &CompiledExpr, rules: ExprRules<'_>) -> ResultShape {
    expr.infer_result_shape(|reference| infer_reference_shape(reference, rules))
}

fn validate_expr_usage(
    site: FieldSite<'_>,
    field: &str,
    expr: &CompiledExpr,
    rules: ExprRules<'_>,
) -> Result<(), ConfigError> {
    let allowed_roots = rules.allowed_roots.iter().copied().collect::<BTreeSet<_>>();
    for root in expr.roots() {
        if !allowed_roots.contains(root) {
            return Err(ConfigError::InvalidExprRoot {
                path: site.path.to_path_buf(),
                location: site.location,
                workflow_id: site.workflow_id.to_string(),
                field: field.to_owned(),
                root: root.as_str().to_owned(),
            });
        }
    }

    for reference in expr.path_references() {
        match reference.root {
            ExprRoot::Inputs => {
                validate_input_reference(site, field, reference, rules.workflow_inputs)?
            }
            ExprRoot::Steps => validate_step_reference(site, field, reference, rules.known_steps)?,
            ExprRoot::Env => {}
            ExprRoot::Run => validate_run_reference(site, field, reference, rules.run_context)?,
        }
    }

    Ok(())
}

fn validate_input_reference(
    site: FieldSite<'_>,
    field: &str,
    reference: &PathReference,
    workflow_inputs: &BTreeMap<String, InputSchema>,
) -> Result<(), ConfigError> {
    let Some(input_name) = reference.segments.first() else {
        return Err(invalid_reference(
            site,
            field,
            "`inputs` must reference a declared field".to_owned(),
        ));
    };
    let Some(schema) = workflow_inputs.get(input_name) else {
        return Err(invalid_reference(
            site,
            field,
            format!("`inputs.{input_name}` is not declared by the workflow"),
        ));
    };
    schema
        .resolve_path(&format!("inputs.{input_name}"), &reference.segments[1..])
        .map(|_| ())
        .map_err(|error| invalid_reference(site, field, error.to_string()))
}

fn validate_step_reference(
    site: FieldSite<'_>,
    field: &str,
    reference: &PathReference,
    known_steps: &BTreeMap<String, ResultShape>,
) -> Result<(), ConfigError> {
    let Some(step_id) = reference.segments.first() else {
        return Err(invalid_reference(
            site,
            field,
            "`steps` must reference a previous step id".to_owned(),
        ));
    };
    let Some(shape) = known_steps.get(step_id) else {
        return Err(ConfigError::ForwardStepReference {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_id: step_id.clone(),
        });
    };
    match reference.segments.get(1).map(String::as_str) {
        Some("result") => {
            validate_result_path(site, field, step_id, shape, &reference.segments[2..])
        }
        Some(other) => Err(invalid_reference(
            site,
            field,
            format!("`steps.{step_id}.{other}` is not available; use `steps.{step_id}.result`"),
        )),
        None => {
            Err(invalid_reference(site, field, format!("`steps.{step_id}` must access `.result`")))
        }
    }
}

fn validate_run_reference(
    site: FieldSite<'_>,
    field: &str,
    reference: &PathReference,
    run_context: RunContext,
) -> Result<(), ConfigError> {
    if run_context == RunContext::Unavailable {
        return Err(invalid_reference(
            site,
            field,
            "`run` is only available inside a loop body and loop `until`/`exports`".to_owned(),
        ));
    }

    let Some(segment) = reference.segments.first().map(String::as_str) else {
        return Ok(());
    };

    match segment {
        "iteration" | "max_iterations" | "node_path" => {
            if reference.segments.len() == 1 {
                Ok(())
            } else {
                Err(invalid_reference(
                    site,
                    field,
                    format!("`run.{segment}` does not support nested field access"),
                ))
            }
        }
        _ => Err(invalid_reference(
            site,
            field,
            "`run` only exposes `iteration`, `max_iterations`, and `node_path`".to_owned(),
        )),
    }
}

fn validate_result_path(
    site: FieldSite<'_>,
    field: &str,
    step_id: &str,
    shape: &ResultShape,
    remaining: &[String],
) -> Result<(), ConfigError> {
    match shape {
        ResultShape::None => Err(invalid_reference(
            site,
            field,
            format!("`steps.{step_id}.result` is not available for this node"),
        )),
        ResultShape::String | ResultShape::Integer | ResultShape::Number | ResultShape::Boolean => {
            if remaining.is_empty() {
                Ok(())
            } else {
                Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.result` does not support nested field access"),
                ))
            }
        }
        ResultShape::Array { items } => {
            let Some(segment) = remaining.first() else {
                return Ok(());
            };
            if segment.parse::<usize>().is_err() {
                return Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.result` array access must use a numeric index"),
                ));
            }
            match items {
                Some(item_shape) => {
                    validate_result_path(site, field, step_id, item_shape, &remaining[1..])
                }
                None => Ok(()),
            }
        }
        ResultShape::AnyJson => Ok(()),
        ResultShape::Object(fields) => {
            let Some(segment) = remaining.first() else {
                return Ok(());
            };
            let Some(child) = fields.get(segment) else {
                return Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.result.{segment}` is not declared"),
                ));
            };
            validate_result_path(site, field, step_id, child, &remaining[1..])
        }
    }
}

fn invalid_reference(site: FieldSite<'_>, field: &str, message: String) -> ConfigError {
    ConfigError::InvalidReference {
        path: site.path.to_path_buf(),
        location: site.location,
        workflow_id: site.workflow_id.to_string(),
        field: field.to_owned(),
        message,
    }
}

fn infer_reference_shape(reference: &PathReference, rules: ExprRules<'_>) -> ResultShape {
    match reference.root {
        ExprRoot::Inputs => infer_input_reference_shape(reference, rules.workflow_inputs),
        ExprRoot::Env => infer_env_reference_shape(reference),
        ExprRoot::Steps => infer_step_reference_shape(reference, rules.known_steps),
        ExprRoot::Run => match reference.segments.first().map(String::as_str) {
            Some("iteration") | Some("max_iterations") => ResultShape::Integer,
            Some("node_path") => ResultShape::String,
            _ => ResultShape::AnyJson,
        },
    }
}

fn infer_env_reference_shape(reference: &PathReference) -> ResultShape {
    if reference.segments.is_empty() { ResultShape::AnyJson } else { ResultShape::String }
}

fn infer_input_reference_shape(
    reference: &PathReference,
    workflow_inputs: &BTreeMap<String, InputSchema>,
) -> ResultShape {
    let Some(input_name) = reference.segments.first() else {
        return ResultShape::AnyJson;
    };
    let Some(schema) = workflow_inputs.get(input_name) else {
        return ResultShape::AnyJson;
    };
    schema
        .resolve_path(&format!("inputs.{input_name}"), &reference.segments[1..])
        .unwrap_or(ResultShape::AnyJson)
}

fn infer_step_reference_shape(
    reference: &PathReference,
    known_steps: &BTreeMap<String, ResultShape>,
) -> ResultShape {
    let Some(step_id) = reference.segments.first() else {
        return ResultShape::AnyJson;
    };
    let Some("result") = reference.segments.get(1).map(String::as_str) else {
        return ResultShape::AnyJson;
    };
    let Some(shape) = known_steps.get(step_id) else {
        return ResultShape::AnyJson;
    };
    shape_at_path(shape, &reference.segments[2..]).unwrap_or(ResultShape::AnyJson)
}

fn shape_at_path(shape: &ResultShape, remaining: &[String]) -> Option<ResultShape> {
    match shape {
        ResultShape::None => None,
        ResultShape::String
        | ResultShape::Integer
        | ResultShape::Number
        | ResultShape::Boolean
        | ResultShape::AnyJson => remaining.is_empty().then(|| shape.clone()),
        ResultShape::Object(fields) => {
            if remaining.is_empty() {
                return Some(shape.clone());
            }
            let segment = remaining.first()?;
            let child = fields.get(segment)?;
            shape_at_path(child, &remaining[1..])
        }
        ResultShape::Array { items } => {
            if remaining.is_empty() {
                return Some(shape.clone());
            }
            let segment = remaining.first()?;
            segment.parse::<usize>().ok()?;
            match items {
                Some(item_shape) => shape_at_path(item_shape, &remaining[1..]),
                None => Some(ResultShape::AnyJson),
            }
        }
    }
}
