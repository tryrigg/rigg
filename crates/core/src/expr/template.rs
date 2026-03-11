use crate::expr::{CompiledExpr, EvalError, EvalOutcome, ExpectedType};
use serde_json::Value as JsonValue;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateSegment {
    Text(String),
    Expr(CompiledExpr),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    source: String,
    segments: Vec<TemplateSegment>,
}

#[derive(Debug, Error)]
pub enum TemplateError {
    #[error("template is missing closing `}}`: {template}")]
    Unclosed { template: String },
    #[error(transparent)]
    Expr(#[from] crate::expr::ExprError),
    #[error(transparent)]
    Eval(#[from] EvalError),
}

impl Template {
    pub fn parse(source: impl Into<String>) -> Result<Self, TemplateError> {
        let source = source.into();
        let mut rest = source.as_str();
        let mut segments = Vec::new();

        while let Some(start) = rest.find("${{") {
            if start > 0 {
                segments.push(TemplateSegment::Text(rest[..start].to_owned()));
            }

            let after_open = &rest[start + 3..];
            let Some(end) = after_open.find("}}") else {
                return Err(TemplateError::Unclosed { template: source });
            };
            let expr_source = after_open[..end].trim().to_owned();
            segments.push(TemplateSegment::Expr(CompiledExpr::compile(
                expr_source,
                Some(ExpectedType::Scalar),
            )?));
            rest = &after_open[end + 2..];
        }

        if !rest.is_empty() {
            segments.push(TemplateSegment::Text(rest.to_owned()));
        }

        Ok(Self { source, segments })
    }

    pub fn compiled_expressions(&self) -> impl Iterator<Item = &CompiledExpr> {
        self.segments.iter().filter_map(|segment| match segment {
            TemplateSegment::Expr(expr) => Some(expr),
            TemplateSegment::Text(_) => None,
        })
    }

    pub fn render(&self, context: &JsonValue) -> Result<String, TemplateError> {
        let mut rendered = String::new();
        for segment in &self.segments {
            match segment {
                TemplateSegment::Text(text) => rendered.push_str(text),
                TemplateSegment::Expr(expr) => match expr.evaluate(context)? {
                    EvalOutcome::Scalar(value) => rendered.push_str(&value),
                    EvalOutcome::Bool(value) => rendered.push_str(&value.to_string()),
                    EvalOutcome::Json(_) => {
                        unreachable!("scalar templates always request scalar values")
                    }
                },
            }
        }
        Ok(rendered)
    }
}

#[cfg(test)]
mod tests {
    use super::Template;
    use serde_json::json;

    #[test]
    fn non_scalar_template_error_mentions_stringify_helpers() {
        let template =
            Template::parse("${{ steps.review.result.findings }}").expect("template should parse");
        let context = json!({
            "steps": {
                "review": {
                    "result": {
                        "findings": [{"severity": "low"}]
                    }
                }
            }
        });

        let error = template.render(&context).expect_err("template should fail to render");

        assert_eq!(
            error.to_string(),
            "expression `steps.review.result.findings` evaluated to non-scalar template value; use toJSON(...) or join(...) to render arrays or objects"
        );
    }
}
