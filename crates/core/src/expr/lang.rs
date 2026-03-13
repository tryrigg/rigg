use crate::ResultShape;
use serde_json::{Number, Value as JsonValue};
use std::collections::BTreeSet;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedType {
    Bool,
    Scalar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExprRoot {
    Inputs,
    Env,
    Steps,
    Run,
}

impl ExprRoot {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inputs => "inputs",
            Self::Env => "env",
            Self::Steps => "steps",
            Self::Run => "run",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathReference {
    pub root: ExprRoot,
    pub segments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledExpr {
    source: String,
    expected: Option<ExpectedType>,
    ast: Expr,
    roots: BTreeSet<ExprRoot>,
    path_references: Vec<PathReference>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalOutcome {
    Bool(bool),
    Scalar(String),
    Json(JsonValue),
}

#[derive(Debug, Error)]
pub enum ExprError {
    #[error("failed to parse expression `{expression}`: {message}")]
    Parse { expression: String, message: String },
    #[error("expression `{expression}` calls unsupported function `{function}`")]
    UnsupportedFunction { expression: String, function: String },
}

#[derive(Debug, Error)]
pub enum EvalError {
    #[error("failed to execute expression `{expression}`: {message}")]
    Execute { expression: String, message: String },
    #[error("expression `{expression}` evaluated to non-boolean value")]
    NonBool { expression: String },
    #[error(
        "expression `{expression}` evaluated to non-scalar template value; use toJSON(...) or join(...) to render arrays or objects"
    )]
    NonScalar { expression: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Expr {
    Literal(Literal),
    Path { root: ExprRoot, segments: Vec<String> },
    UnaryNot(Box<Expr>),
    Binary { left: Box<Expr>, op: BinaryOp, right: Box<Expr> },
    Call { name: String, args: Vec<Expr> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Literal {
    Null,
    Bool(bool),
    Number(String),
    String(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BinaryOp {
    Or,
    And,
    Eq,
    NotEq,
    Greater,
    GreaterEq,
    Less,
    LessEq,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    LeftParen,
    RightParen,
    Comma,
    Dot,
    Not,
    And,
    Or,
    Eq,
    NotEq,
    Greater,
    GreaterEq,
    Less,
    LessEq,
    Number(String),
    String(String),
    Identifier(String),
    Boolean(bool),
    Null,
    End,
}

impl CompiledExpr {
    pub fn compile(
        source: impl Into<String>,
        expected: Option<ExpectedType>,
    ) -> Result<Self, ExprError> {
        let source = source.into();
        let mut parser = Parser::new(&source)?;
        let ast = parser.parse_expression()?;
        let mut roots = BTreeSet::new();
        let mut path_references = Vec::new();
        collect_metadata(&ast, &mut roots, &mut path_references);
        validate_functions(&source, &ast)?;
        Ok(Self { source, expected, ast, roots, path_references })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn roots(&self) -> &BTreeSet<ExprRoot> {
        &self.roots
    }

    pub fn path_references(&self) -> &[PathReference] {
        &self.path_references
    }

    pub fn direct_path_reference(&self) -> Option<PathReference> {
        match &self.ast {
            Expr::Path { root, segments } => {
                Some(PathReference { root: *root, segments: segments.clone() })
            }
            _ => None,
        }
    }

    pub fn infer_result_shape(
        &self,
        mut resolve_path: impl FnMut(&PathReference) -> ResultShape,
    ) -> ResultShape {
        infer_expr_shape(&self.ast, &mut resolve_path)
    }

    pub fn evaluate(&self, context_value: &JsonValue) -> Result<EvalOutcome, EvalError> {
        let value = eval_expr(&self.ast, context_value)
            .map_err(|message| EvalError::Execute { expression: self.source.clone(), message })?;
        match self.expected {
            Some(ExpectedType::Bool) => value
                .as_bool()
                .map(EvalOutcome::Bool)
                .ok_or_else(|| EvalError::NonBool { expression: self.source.clone() }),
            Some(ExpectedType::Scalar) => {
                render_scalar(&self.source, &value).map(EvalOutcome::Scalar)
            }
            None => Ok(EvalOutcome::Json(value)),
        }
    }
}

fn validate_functions(source: &str, expr: &Expr) -> Result<(), ExprError> {
    match expr {
        Expr::Literal(_) | Expr::Path { .. } => Ok(()),
        Expr::UnaryNot(inner) => validate_functions(source, inner),
        Expr::Binary { left, right, .. } => {
            validate_functions(source, left)?;
            validate_functions(source, right)
        }
        Expr::Call { name, args } => {
            if !matches!(
                name.as_str(),
                "contains"
                    | "startsWith"
                    | "endsWith"
                    | "format"
                    | "join"
                    | "toJSON"
                    | "fromJSON"
                    | "len"
            ) {
                return Err(ExprError::UnsupportedFunction {
                    expression: source.to_owned(),
                    function: name.clone(),
                });
            }
            for arg in args {
                validate_functions(source, arg)?;
            }
            Ok(())
        }
    }
}

fn collect_metadata(
    expr: &Expr,
    roots: &mut BTreeSet<ExprRoot>,
    path_references: &mut Vec<PathReference>,
) {
    match expr {
        Expr::Literal(_) => {}
        Expr::Path { root, segments } => {
            roots.insert(*root);
            path_references.push(PathReference { root: *root, segments: segments.clone() });
        }
        Expr::UnaryNot(inner) => collect_metadata(inner, roots, path_references),
        Expr::Binary { left, right, .. } => {
            collect_metadata(left, roots, path_references);
            collect_metadata(right, roots, path_references);
        }
        Expr::Call { args, .. } => {
            for arg in args {
                collect_metadata(arg, roots, path_references);
            }
        }
    }
}

fn eval_expr(expr: &Expr, context: &JsonValue) -> Result<JsonValue, String> {
    match expr {
        Expr::Literal(literal) => Ok(match literal {
            Literal::Null => JsonValue::Null,
            Literal::Bool(value) => JsonValue::Bool(*value),
            Literal::Number(value) => parse_number(value)?,
            Literal::String(value) => JsonValue::String(value.clone()),
        }),
        Expr::Path { root, segments } => Ok(resolve_path(context, *root, segments)),
        Expr::UnaryNot(inner) => Ok(JsonValue::Bool(!truthy(&eval_expr(inner, context)?))),
        Expr::Binary { left, op, right } => eval_binary(left, *op, right, context),
        Expr::Call { name, args } => eval_call(name, args, context),
    }
}

fn infer_expr_shape(
    expr: &Expr,
    resolve_path: &mut impl FnMut(&PathReference) -> ResultShape,
) -> ResultShape {
    match expr {
        Expr::Literal(literal) => infer_literal_shape(literal),
        Expr::Path { root, segments } => {
            resolve_path(&PathReference { root: *root, segments: segments.clone() })
        }
        Expr::UnaryNot(_) => ResultShape::Boolean,
        Expr::Binary { .. } => ResultShape::Boolean,
        Expr::Call { name, args } => infer_call_shape(name, args, resolve_path),
    }
}

fn infer_call_shape(
    name: &str,
    args: &[Expr],
    resolve_path: &mut impl FnMut(&PathReference) -> ResultShape,
) -> ResultShape {
    match name {
        "contains" | "startsWith" | "endsWith" => ResultShape::Boolean,
        "len" => ResultShape::Integer,
        "format" | "join" | "toJSON" => ResultShape::String,
        "fromJSON" => infer_from_json_shape(args, resolve_path),
        _ => ResultShape::AnyJson,
    }
}

fn infer_from_json_shape(
    args: &[Expr],
    resolve_path: &mut impl FnMut(&PathReference) -> ResultShape,
) -> ResultShape {
    let Some(arg) = args.first() else {
        return ResultShape::AnyJson;
    };

    match arg {
        Expr::Literal(Literal::String(value)) => serde_json::from_str::<JsonValue>(value)
            .map(|value| infer_json_shape(&value))
            .unwrap_or(ResultShape::AnyJson),
        Expr::Call { name, args } if name == "toJSON" && args.len() == 1 => {
            infer_expr_shape(&args[0], resolve_path)
        }
        _ => ResultShape::AnyJson,
    }
}

fn infer_literal_shape(literal: &Literal) -> ResultShape {
    match literal {
        Literal::Null => ResultShape::AnyJson,
        Literal::Bool(_) => ResultShape::Boolean,
        Literal::String(_) => ResultShape::String,
        Literal::Number(value) => {
            if value.parse::<i64>().is_ok() || value.parse::<u64>().is_ok() {
                ResultShape::Integer
            } else {
                ResultShape::Number
            }
        }
    }
}

fn infer_json_shape(value: &JsonValue) -> ResultShape {
    match value {
        JsonValue::Null => ResultShape::AnyJson,
        JsonValue::Bool(_) => ResultShape::Boolean,
        JsonValue::Number(number) => {
            if number.as_i64().is_some() || number.as_u64().is_some() {
                ResultShape::Integer
            } else {
                ResultShape::Number
            }
        }
        JsonValue::String(_) => ResultShape::String,
        JsonValue::Array(items) => ResultShape::Array {
            items: merge_array_item_shapes(
                items.iter().map(infer_json_shape).collect::<Vec<_>>().as_slice(),
            )
            .map(Box::new),
        },
        JsonValue::Object(fields) => ResultShape::Object(
            fields.iter().map(|(key, value)| (key.clone(), infer_json_shape(value))).collect(),
        ),
    }
}

fn merge_array_item_shapes(shapes: &[ResultShape]) -> Option<ResultShape> {
    let mut merged = None;
    for shape in shapes {
        merged = Some(match merged {
            None => shape.clone(),
            Some(current) => merge_inferred_shapes(&current, shape),
        });
    }
    merged
}

fn merge_inferred_shapes(left: &ResultShape, right: &ResultShape) -> ResultShape {
    match (left, right) {
        (ResultShape::AnyJson, _) | (_, ResultShape::AnyJson) => ResultShape::AnyJson,
        (ResultShape::None, _) | (_, ResultShape::None) => ResultShape::AnyJson,
        (ResultShape::String, ResultShape::String) => ResultShape::String,
        (ResultShape::Integer, ResultShape::Integer) => ResultShape::Integer,
        (ResultShape::Number, ResultShape::Number) => ResultShape::Number,
        (ResultShape::Integer, ResultShape::Number)
        | (ResultShape::Number, ResultShape::Integer) => ResultShape::Number,
        (ResultShape::Boolean, ResultShape::Boolean) => ResultShape::Boolean,
        (ResultShape::Object(left_fields), ResultShape::Object(right_fields))
            if left_fields.keys().eq(right_fields.keys()) =>
        {
            ResultShape::Object(
                left_fields
                    .iter()
                    .filter_map(|(key, left_shape)| {
                        right_fields.get(key).map(|right_shape| {
                            (key.clone(), merge_inferred_shapes(left_shape, right_shape))
                        })
                    })
                    .collect(),
            )
        }
        (ResultShape::Array { items: left_items }, ResultShape::Array { items: right_items }) => {
            ResultShape::Array {
                items: match (left_items, right_items) {
                    (Some(left_item), Some(right_item)) => {
                        Some(Box::new(merge_inferred_shapes(left_item, right_item)))
                    }
                    (Some(item), None) | (None, Some(item)) => Some(item.clone()),
                    (None, None) => None,
                },
            }
        }
        _ => ResultShape::AnyJson,
    }
}

fn eval_binary(
    left: &Expr,
    op: BinaryOp,
    right: &Expr,
    context: &JsonValue,
) -> Result<JsonValue, String> {
    match op {
        BinaryOp::Or => {
            let left_value = eval_expr(left, context)?;
            if truthy(&left_value) {
                return Ok(JsonValue::Bool(true));
            }
            Ok(JsonValue::Bool(truthy(&eval_expr(right, context)?)))
        }
        BinaryOp::And => {
            let left_value = eval_expr(left, context)?;
            if !truthy(&left_value) {
                return Ok(JsonValue::Bool(false));
            }
            Ok(JsonValue::Bool(truthy(&eval_expr(right, context)?)))
        }
        BinaryOp::Eq => Ok(JsonValue::Bool(
            compare_json(&eval_expr(left, context)?, &eval_expr(right, context)?)
                == Some(std::cmp::Ordering::Equal),
        )),
        BinaryOp::NotEq => Ok(JsonValue::Bool(
            compare_json(&eval_expr(left, context)?, &eval_expr(right, context)?)
                != Some(std::cmp::Ordering::Equal),
        )),
        BinaryOp::Greater => compare_order(left, right, context, std::cmp::Ordering::Greater),
        BinaryOp::GreaterEq => {
            compare_order_inclusive(left, right, context, std::cmp::Ordering::Greater)
        }
        BinaryOp::Less => compare_order(left, right, context, std::cmp::Ordering::Less),
        BinaryOp::LessEq => compare_order_inclusive(left, right, context, std::cmp::Ordering::Less),
    }
}

fn compare_order(
    left: &Expr,
    right: &Expr,
    context: &JsonValue,
    wanted: std::cmp::Ordering,
) -> Result<JsonValue, String> {
    let ordering = compare_json(&eval_expr(left, context)?, &eval_expr(right, context)?);
    Ok(JsonValue::Bool(ordering == Some(wanted)))
}

fn compare_order_inclusive(
    left: &Expr,
    right: &Expr,
    context: &JsonValue,
    wanted: std::cmp::Ordering,
) -> Result<JsonValue, String> {
    let ordering = compare_json(&eval_expr(left, context)?, &eval_expr(right, context)?);
    Ok(JsonValue::Bool(matches!(
        ordering,
        Some(found) if found == wanted || found == std::cmp::Ordering::Equal
    )))
}

fn compare_json(left: &JsonValue, right: &JsonValue) -> Option<std::cmp::Ordering> {
    if let (Some(left_number), Some(right_number)) = (as_f64(left), as_f64(right)) {
        return left_number.partial_cmp(&right_number);
    }

    match (left, right) {
        (JsonValue::String(left), JsonValue::String(right)) => Some(left.cmp(right)),
        (JsonValue::Bool(left), JsonValue::Bool(right)) => Some(left.cmp(right)),
        (JsonValue::Null, JsonValue::Null) => Some(std::cmp::Ordering::Equal),
        _ if left == right => Some(std::cmp::Ordering::Equal),
        _ => None,
    }
}

fn eval_call(name: &str, args: &[Expr], context: &JsonValue) -> Result<JsonValue, String> {
    match name {
        "contains" => {
            ensure_arity(name, args, 2)?;
            let haystack = eval_expr(&args[0], context)?;
            let needle = eval_expr(&args[1], context)?;
            Ok(JsonValue::Bool(match haystack {
                JsonValue::String(text) => text.contains(&stringify(&needle)?),
                JsonValue::Array(items) => items.iter().any(|item| item == &needle),
                _ => false,
            }))
        }
        "startsWith" => {
            ensure_arity(name, args, 2)?;
            Ok(JsonValue::Bool(
                stringify(&eval_expr(&args[0], context)?)?
                    .starts_with(&stringify(&eval_expr(&args[1], context)?)?),
            ))
        }
        "endsWith" => {
            ensure_arity(name, args, 2)?;
            Ok(JsonValue::Bool(
                stringify(&eval_expr(&args[0], context)?)?
                    .ends_with(&stringify(&eval_expr(&args[1], context)?)?),
            ))
        }
        "format" => {
            if args.is_empty() {
                return Err("format expects at least one argument".to_owned());
            }
            let template = stringify(&eval_expr(&args[0], context)?)?;
            let mut rendered = template;
            for (index, argument) in args.iter().enumerate().skip(1) {
                rendered = rendered.replace(
                    &format!("{{{}}}", index - 1),
                    &stringify(&eval_expr(argument, context)?)?,
                );
            }
            Ok(JsonValue::String(rendered))
        }
        "join" => {
            ensure_arity(name, args, 2)?;
            let values = eval_expr(&args[0], context)?;
            let separator = stringify(&eval_expr(&args[1], context)?)?;
            match values {
                JsonValue::Array(items) => {
                    let parts = items.iter().map(stringify).collect::<Result<Vec<_>, _>>()?;
                    Ok(JsonValue::String(parts.join(&separator)))
                }
                _ => Err("join expects an array as the first argument".to_owned()),
            }
        }
        "toJSON" => {
            ensure_arity(name, args, 1)?;
            Ok(JsonValue::String(
                serde_json::to_string(&eval_expr(&args[0], context)?)
                    .map_err(|error| error.to_string())?,
            ))
        }
        "fromJSON" => {
            ensure_arity(name, args, 1)?;
            let text = stringify(&eval_expr(&args[0], context)?)?;
            serde_json::from_str(&text).map_err(|error| error.to_string())
        }
        "len" => {
            ensure_arity(name, args, 1)?;
            let value = eval_expr(&args[0], context)?;
            let length = match value {
                JsonValue::String(text) => text.chars().count(),
                JsonValue::Array(items) => items.len(),
                JsonValue::Object(fields) => fields.len(),
                _ => return Err("len expects a string, array, or object".to_owned()),
            };
            Ok(JsonValue::Number(Number::from(length as u64)))
        }
        _ => Err(format!("unsupported function `{name}`")),
    }
}

fn ensure_arity(name: &str, args: &[Expr], expected: usize) -> Result<(), String> {
    if args.len() == expected {
        Ok(())
    } else {
        Err(format!("{name} expects {expected} argument(s), got {}", args.len()))
    }
}

fn parse_number(value: &str) -> Result<JsonValue, String> {
    if let Ok(number) = value.parse::<i64>() {
        return Ok(JsonValue::Number(Number::from(number)));
    }
    let number = value.parse::<f64>().map_err(|error| error.to_string())?;
    Number::from_f64(number)
        .map(JsonValue::Number)
        .ok_or_else(|| format!("invalid number literal `{value}`"))
}

fn resolve_path(context: &JsonValue, root: ExprRoot, segments: &[String]) -> JsonValue {
    let mut current = context
        .as_object()
        .and_then(|object| object.get(root.as_str()))
        .cloned()
        .unwrap_or(JsonValue::Null);
    for segment in segments {
        current = match current {
            JsonValue::Object(object) => object.get(segment).cloned().unwrap_or(JsonValue::Null),
            JsonValue::Array(items) => segment
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index).cloned())
                .unwrap_or(JsonValue::Null),
            _ => JsonValue::Null,
        };
    }
    current
}

fn render_scalar(source: &str, value: &JsonValue) -> Result<String, EvalError> {
    match value {
        JsonValue::Null => Ok(String::new()),
        JsonValue::String(text) => Ok(text.clone()),
        JsonValue::Number(number) => Ok(number.to_string()),
        JsonValue::Bool(flag) => Ok(flag.to_string()),
        _ => Err(EvalError::NonScalar { expression: source.to_owned() }),
    }
}

fn stringify(value: &JsonValue) -> Result<String, String> {
    match value {
        JsonValue::Null => Ok(String::new()),
        JsonValue::String(text) => Ok(text.clone()),
        JsonValue::Number(number) => Ok(number.to_string()),
        JsonValue::Bool(flag) => Ok(flag.to_string()),
        _ => serde_json::to_string(value).map_err(|error| error.to_string()),
    }
}

fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(flag) => *flag,
        JsonValue::Number(number) => match number.as_f64() {
            Some(number) => number != 0.0,
            None => false,
        },
        JsonValue::String(text) => !text.is_empty(),
        JsonValue::Array(items) => !items.is_empty(),
        JsonValue::Object(object) => !object.is_empty(),
    }
}

fn as_f64(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(number) => number.as_f64(),
        _ => None,
    }
}

struct Parser<'a> {
    source: &'a str,
    tokens: Vec<Token>,
    index: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Result<Self, ExprError> {
        Ok(Self { source, tokens: tokenize(source)?, index: 0 })
    }

    fn parse_expression(&mut self) -> Result<Expr, ExprError> {
        let expr = self.parse_or()?;
        if !matches!(self.peek(), Token::End) {
            return Err(self.error("unexpected token"));
        }
        Ok(expr)
    }

    fn parse_or(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_and()?;
        while matches!(self.peek(), Token::Or) {
            self.advance();
            expr = Expr::Binary {
                left: Box::new(expr),
                op: BinaryOp::Or,
                right: Box::new(self.parse_and()?),
            };
        }
        Ok(expr)
    }

    fn parse_and(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_comparison()?;
        while matches!(self.peek(), Token::And) {
            self.advance();
            expr = Expr::Binary {
                left: Box::new(expr),
                op: BinaryOp::And,
                right: Box::new(self.parse_comparison()?),
            };
        }
        Ok(expr)
    }

    fn parse_comparison(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Token::Eq => BinaryOp::Eq,
                Token::NotEq => BinaryOp::NotEq,
                Token::Greater => BinaryOp::Greater,
                Token::GreaterEq => BinaryOp::GreaterEq,
                Token::Less => BinaryOp::Less,
                Token::LessEq => BinaryOp::LessEq,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary { left: Box::new(expr), op, right: Box::new(self.parse_unary()?) };
        }
        Ok(expr)
    }

    fn parse_unary(&mut self) -> Result<Expr, ExprError> {
        if matches!(self.peek(), Token::Not) {
            self.advance();
            return Ok(Expr::UnaryNot(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, ExprError> {
        match self.advance() {
            Token::LeftParen => {
                let expr = self.parse_or()?;
                self.expect(Token::RightParen)?;
                Ok(expr)
            }
            Token::String(value) => Ok(Expr::Literal(Literal::String(value))),
            Token::Number(value) => Ok(Expr::Literal(Literal::Number(value))),
            Token::Boolean(value) => Ok(Expr::Literal(Literal::Bool(value))),
            Token::Null => Ok(Expr::Literal(Literal::Null)),
            Token::Identifier(name) => self.parse_identifier(name),
            _ => Err(self.error("expected a value")),
        }
    }

    fn parse_identifier(&mut self, name: String) -> Result<Expr, ExprError> {
        if matches!(self.peek(), Token::LeftParen) {
            self.advance();
            let mut args = Vec::new();
            if !matches!(self.peek(), Token::RightParen) {
                loop {
                    args.push(self.parse_or()?);
                    if matches!(self.peek(), Token::Comma) {
                        self.advance();
                        continue;
                    }
                    break;
                }
            }
            self.expect(Token::RightParen)?;
            return Ok(Expr::Call { name, args });
        }

        let root = match name.as_str() {
            "inputs" => ExprRoot::Inputs,
            "env" => ExprRoot::Env,
            "steps" => ExprRoot::Steps,
            "run" => ExprRoot::Run,
            _ => return Err(self.error(&format!("unknown identifier `{name}`"))),
        };

        let mut segments = Vec::new();
        while matches!(self.peek(), Token::Dot) {
            self.advance();
            match self.advance() {
                Token::Identifier(segment) => segments.push(segment),
                Token::Number(segment) => segments.push(segment),
                _ => return Err(self.error("expected a property name after `.`")),
            }
        }

        Ok(Expr::Path { root, segments })
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.index).unwrap_or(&Token::End)
    }

    fn advance(&mut self) -> Token {
        let token = self.tokens.get(self.index).cloned().unwrap_or(Token::End);
        self.index += 1;
        token
    }

    fn expect(&mut self, expected: Token) -> Result<(), ExprError> {
        let token = self.advance();
        if token == expected { Ok(()) } else { Err(self.error("unexpected token")) }
    }

    fn error(&self, message: &str) -> ExprError {
        ExprError::Parse { expression: self.source.to_owned(), message: message.to_owned() }
    }
}

fn tokenize(source: &str) -> Result<Vec<Token>, ExprError> {
    let mut chars = source.char_indices().peekable();
    let mut tokens = Vec::new();

    while let Some((index, ch)) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }

        let token = match ch {
            '(' => Token::LeftParen,
            ')' => Token::RightParen,
            ',' => Token::Comma,
            '.' => Token::Dot,
            '!' => {
                if matches!(chars.peek(), Some((_, '='))) {
                    chars.next();
                    Token::NotEq
                } else {
                    Token::Not
                }
            }
            '&' => {
                if matches!(chars.peek(), Some((_, '&'))) {
                    chars.next();
                    Token::And
                } else {
                    return Err(parse_error(source, index, "expected `&&`"));
                }
            }
            '|' => {
                if matches!(chars.peek(), Some((_, '|'))) {
                    chars.next();
                    Token::Or
                } else {
                    return Err(parse_error(source, index, "expected `||`"));
                }
            }
            '=' => {
                if matches!(chars.peek(), Some((_, '='))) {
                    chars.next();
                    Token::Eq
                } else {
                    return Err(parse_error(source, index, "expected `==`"));
                }
            }
            '>' => {
                if matches!(chars.peek(), Some((_, '='))) {
                    chars.next();
                    Token::GreaterEq
                } else {
                    Token::Greater
                }
            }
            '<' => {
                if matches!(chars.peek(), Some((_, '='))) {
                    chars.next();
                    Token::LessEq
                } else {
                    Token::Less
                }
            }
            '\'' | '"' => Token::String(read_string(source, &mut chars, ch, index)?),
            '-' | '0'..='9' => {
                let mut literal = String::from(ch);
                while let Some((_, next)) = chars.peek().copied() {
                    if next.is_ascii_digit() {
                        literal.push(next);
                        chars.next();
                    } else if next == '.' {
                        let mut lookahead = chars.clone();
                        lookahead.next();
                        if matches!(lookahead.peek(), Some((_, after_dot)) if after_dot.is_ascii_digit())
                        {
                            literal.push(next);
                            chars.next();
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                Token::Number(literal)
            }
            _ if is_ident_start(ch) => {
                let mut ident = String::from(ch);
                while let Some((_, next)) = chars.peek() {
                    if is_ident_continue(*next) {
                        ident.push(*next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                match ident.as_str() {
                    "true" => Token::Boolean(true),
                    "false" => Token::Boolean(false),
                    "null" => Token::Null,
                    _ => Token::Identifier(ident),
                }
            }
            _ => return Err(parse_error(source, index, &format!("unexpected character `{ch}`"))),
        };
        tokens.push(token);
    }

    tokens.push(Token::End);
    Ok(tokens)
}

fn read_string(
    source: &str,
    chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
    quote: char,
    start: usize,
) -> Result<String, ExprError> {
    let mut value = String::new();
    while let Some((_, ch)) = chars.next() {
        if ch == quote {
            return Ok(value);
        }
        if ch == '\\' {
            let Some((_, escaped)) = chars.next() else {
                break;
            };
            let translated = match escaped {
                '\\' => '\\',
                '\'' => '\'',
                '"' => '"',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            };
            value.push(translated);
            continue;
        }
        value.push(ch);
    }

    Err(parse_error(source, start, "unterminated string literal"))
}

fn parse_error(source: &str, index: usize, message: &str) -> ExprError {
    ExprError::Parse {
        expression: source.to_owned(),
        message: format!("{message} at byte {index}"),
    }
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_ident_continue(ch: char) -> bool {
    is_ident_start(ch) || ch.is_ascii_digit() || ch == '-'
}

#[cfg(test)]
mod tests {
    use super::{CompiledExpr, EvalOutcome, ResultShape};
    use serde_json::json;

    #[test]
    fn len_returns_integer_shape() {
        let expr = CompiledExpr::compile("len(steps.review.result.findings)", None).unwrap();

        let shape = expr.infer_result_shape(|_| ResultShape::Array {
            items: Some(Box::new(ResultShape::Object(Default::default()))),
        });

        assert_eq!(shape, ResultShape::Integer);
    }

    #[test]
    fn len_evaluates_array_lengths() {
        let expr = CompiledExpr::compile("len(steps.review.result.findings)", None).unwrap();
        let value = expr
            .evaluate(&json!({
                "steps": {
                    "review": {
                        "result": {
                            "findings": [{"title": "one"}, {"title": "two"}]
                        }
                    }
                }
            }))
            .unwrap();

        assert_eq!(value, EvalOutcome::Json(json!(2)));
    }
}
