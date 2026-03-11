use super::{ConfigError, ExprRules, FieldSite};
use crate::loader::expr::{compile_template, compile_wrapped_expr, infer_expr_shape};
use rigg_core::{
    ExportField, ExportSpec, ResultShape, TemplateField, ValidatedBlock, ValidatedNode, WorkflowEnv,
};
use std::collections::BTreeMap;

pub(super) fn compile_exports(
    site: FieldSite<'_>,
    exports: BTreeMap<String, String>,
    rules: ExprRules<'_>,
) -> Result<Option<ExportSpec>, ConfigError> {
    compile_exports_inner(site, None, exports, rules)
}

pub(super) fn compile_exports_for_case(
    site: FieldSite<'_>,
    case_index: usize,
    exports: BTreeMap<String, String>,
    rules: ExprRules<'_>,
) -> Result<Option<ExportSpec>, ConfigError> {
    compile_exports_inner(site, Some(case_index), exports, rules)
}

fn compile_exports_inner(
    site: FieldSite<'_>,
    case_index: Option<usize>,
    exports: BTreeMap<String, String>,
    rules: ExprRules<'_>,
) -> Result<Option<ExportSpec>, ConfigError> {
    if exports.is_empty() {
        return Ok(None);
    }

    let fields = exports
        .into_iter()
        .map(|(key, source)| {
            let field_name = match case_index {
                Some(case_index) => format!("cases[{case_index}].exports.{key}"),
                None => format!("exports.{key}"),
            };
            let expr = compile_wrapped_expr(site, &field_name, &source, None, rules)?;
            Ok(ExportField { key, expr })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(ExportSpec {
        shape: ResultShape::Object(
            fields
                .iter()
                .map(|field| (field.key.clone(), infer_expr_shape(&field.expr, rules)))
                .collect(),
        ),
        fields,
    }))
}

pub(super) fn guaranteed_scope_after_block(
    inherited_scope: &BTreeMap<String, ResultShape>,
    block: &ValidatedBlock,
) -> BTreeMap<String, ResultShape> {
    let mut visible_steps = inherited_scope.clone();
    for node in &block.nodes {
        if let Some(user_id) = &node.user_id {
            visible_steps.insert(user_id.to_string(), guaranteed_result_shape(node));
        }
    }
    visible_steps
}

pub(super) fn guaranteed_result_shape(node: &ValidatedNode) -> ResultShape {
    if node.attrs.if_expr.is_some() { ResultShape::None } else { node.public_result.result_shape() }
}

pub(super) fn merge_result_shapes(left: &ResultShape, right: &ResultShape) -> Option<ResultShape> {
    match (left, right) {
        (ResultShape::AnyJson, _) | (_, ResultShape::AnyJson) => Some(ResultShape::AnyJson),
        (ResultShape::None, _) | (_, ResultShape::None) => None,
        (ResultShape::String, ResultShape::String) => Some(ResultShape::String),
        (ResultShape::Integer, ResultShape::Integer) => Some(ResultShape::Integer),
        (ResultShape::Number, ResultShape::Number) => Some(ResultShape::Number),
        (ResultShape::Integer, ResultShape::Number)
        | (ResultShape::Number, ResultShape::Integer) => Some(ResultShape::Number),
        (ResultShape::Boolean, ResultShape::Boolean) => Some(ResultShape::Boolean),
        (ResultShape::Object(left_fields), ResultShape::Object(right_fields)) => {
            if left_fields.len() != right_fields.len() {
                return None;
            }
            let mut fields = BTreeMap::new();
            for (key, left_shape) in left_fields {
                let right_shape = right_fields.get(key)?;
                fields.insert(key.clone(), merge_result_shapes(left_shape, right_shape)?);
            }
            Some(ResultShape::Object(fields))
        }
        (ResultShape::Array { items: left_items }, ResultShape::Array { items: right_items }) => {
            let items = match (left_items, right_items) {
                (Some(left_item), Some(right_item)) => {
                    Some(Box::new(merge_result_shapes(left_item, right_item)?))
                }
                (None, None) => None,
                _ => Some(Box::new(ResultShape::AnyJson)),
            };
            Some(ResultShape::Array { items })
        }
        _ => None,
    }
}

pub(super) fn compile_env(
    site: FieldSite<'_>,
    env: BTreeMap<String, String>,
    rules: ExprRules<'_>,
) -> Result<WorkflowEnv, ConfigError> {
    env.into_iter()
        .map(|(key, value)| {
            Ok(TemplateField { key, value: compile_template(site, "env", value, rules)? })
        })
        .collect()
}
