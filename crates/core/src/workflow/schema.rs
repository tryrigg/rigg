use regex::Regex;
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonResultSchema {
    json_schema: JsonValue,
    structured: OutputSchema,
}

impl JsonResultSchema {
    pub fn parse_at(
        schema: &JsonValue,
        root_path: impl Into<String>,
    ) -> Result<Self, OutputSchemaError> {
        let structured = OutputSchema::parse_at(schema, root_path)?;
        let json_schema = structured.to_json_schema();
        Ok(Self { json_schema, structured })
    }

    pub fn json_schema(&self) -> &JsonValue {
        &self.json_schema
    }

    pub fn structured(&self) -> &OutputSchema {
        &self.structured
    }

    pub fn result_shape(&self) -> ResultShape {
        self.structured.result_shape()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultShape {
    None,
    String,
    Integer,
    Number,
    Boolean,
    Object(BTreeMap<String, ResultShape>),
    Array { items: Option<Box<ResultShape>> },
    AnyJson,
}

impl ResultShape {
    pub fn from_output_type(output_type: OutputType) -> Self {
        match output_type {
            OutputType::String => Self::String,
            OutputType::Integer => Self::Integer,
            OutputType::Number => Self::Number,
            OutputType::Boolean => Self::Boolean,
            OutputType::Object => Self::Object(BTreeMap::new()),
            OutputType::Array => Self::Array { items: None },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputType {
    String,
    Integer,
    Number,
    Boolean,
    Object,
    Array,
}

impl OutputType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Integer => "integer",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Object => "object",
            Self::Array => "array",
        }
    }

    pub fn to_schema(self) -> JsonValue {
        serde_json::json!({
            "type": self.as_str(),
        })
    }

    pub fn matches_json_value(self, value: &JsonValue) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
            Self::Number => value.is_number(),
            Self::Boolean => value.is_boolean(),
            Self::Object => value.is_object(),
            Self::Array => value.is_array(),
        }
    }
}

impl Display for OutputType {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputValueType {
    String,
    Integer,
    Number,
    Boolean,
    Object,
    Array,
}

impl InputValueType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Integer => "integer",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Object => "object",
            Self::Array => "array",
        }
    }
}

impl Display for InputValueType {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputSchema {
    description: Option<String>,
    default: Option<JsonValue>,
    enum_values: Option<Vec<JsonValue>>,
    kind: InputSchemaKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InputSchemaKind {
    String { min_length: Option<usize>, max_length: Option<usize>, pattern: Option<InputPattern> },
    Integer { minimum: Option<JsonNumber>, maximum: Option<JsonNumber> },
    Number { minimum: Option<JsonNumber>, maximum: Option<JsonNumber> },
    Boolean,
    Object { properties: BTreeMap<String, InputSchema>, required: BTreeSet<String> },
    Array { items: Box<InputSchema>, min_items: Option<usize>, max_items: Option<usize> },
}

#[derive(Debug, Clone)]
struct InputPattern {
    source: String,
    regex: Regex,
}

impl InputPattern {
    fn parse(path: &str, pattern: &str) -> Result<Self, InputSchemaError> {
        let regex = Regex::new(pattern).map_err(|error| {
            InputSchemaError::new(
                format!("{path}.pattern"),
                format!("is not a valid regex: {error}"),
            )
        })?;
        Ok(Self { source: pattern.to_owned(), regex })
    }
}

impl PartialEq for InputPattern {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source
    }
}

impl Eq for InputPattern {}

impl InputSchema {
    pub fn parse_at(
        schema: &JsonValue,
        root_path: impl Into<String>,
    ) -> Result<Self, InputSchemaError> {
        Self::parse_inner(schema, root_path.into(), true)
    }

    pub fn default(&self) -> Option<&JsonValue> {
        self.default.as_ref()
    }

    pub fn result_shape(&self) -> ResultShape {
        match &self.kind {
            InputSchemaKind::String { .. } => ResultShape::String,
            InputSchemaKind::Integer { .. } => ResultShape::Integer,
            InputSchemaKind::Number { .. } => ResultShape::Number,
            InputSchemaKind::Boolean => ResultShape::Boolean,
            InputSchemaKind::Object { properties, .. } => ResultShape::Object(
                properties
                    .iter()
                    .map(|(key, schema)| (key.clone(), schema.result_shape()))
                    .collect(),
            ),
            InputSchemaKind::Array { items, .. } => {
                ResultShape::Array { items: Some(Box::new(items.result_shape())) }
            }
        }
    }

    pub fn resolve_path(
        &self,
        root_path: &str,
        remaining: &[String],
    ) -> Result<ResultShape, InputPathError> {
        if remaining.is_empty() {
            return Ok(self.result_shape());
        }
        let Some(segment) = remaining.first() else {
            return Ok(self.result_shape());
        };

        match &self.kind {
            InputSchemaKind::String { .. }
            | InputSchemaKind::Integer { .. }
            | InputSchemaKind::Number { .. }
            | InputSchemaKind::Boolean => Err(InputPathError::new(
                root_path,
                InputPathErrorKind::UnsupportedNestedFieldAccess,
            )),
            InputSchemaKind::Object { properties, .. } => {
                let child = properties.get(segment).ok_or_else(|| {
                    InputPathError::new(
                        join_object_field_path(Some(root_path), segment),
                        InputPathErrorKind::UndeclaredProperty,
                    )
                })?;
                child.resolve_path(
                    &join_object_field_path(Some(root_path), segment),
                    &remaining[1..],
                )
            }
            InputSchemaKind::Array { items, .. } => {
                if segment.parse::<usize>().is_err() {
                    return Err(InputPathError::new(
                        root_path,
                        InputPathErrorKind::ArrayIndexMustBeNumeric,
                    ));
                }
                items.resolve_path(&format!("{root_path}.{segment}"), &remaining[1..])
            }
        }
    }

    pub fn validate_and_normalize(
        &self,
        field_path: Option<&str>,
        value: &JsonValue,
    ) -> Result<JsonValue, InputValidationError> {
        let field_path = field_path.unwrap_or("input");
        self.validate_value(field_path, value)?;
        Ok(value.clone())
    }

    fn validate_value(&self, path: &str, value: &JsonValue) -> Result<(), InputValidationError> {
        match &self.kind {
            InputSchemaKind::String { min_length, max_length, pattern } => {
                let Some(text) = value.as_str() else {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::TypeMismatch { expected: InputValueType::String },
                    ));
                };

                validate_enum_value(path, value, self.enum_values.as_deref())?;
                let length = text.chars().count();
                if let Some(min_length) = min_length
                    && length < *min_length
                {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::MinLengthViolation { min_length: *min_length },
                    ));
                }
                if let Some(max_length) = max_length
                    && length > *max_length
                {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::MaxLengthViolation { max_length: *max_length },
                    ));
                }
                if let Some(pattern) = pattern
                    && !pattern.regex.is_match(text)
                {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::PatternViolation { pattern: pattern.source.clone() },
                    ));
                }
                Ok(())
            }
            InputSchemaKind::Integer { minimum, maximum } => validate_numeric_value(
                path,
                value,
                InputValueType::Integer,
                self.enum_values.as_deref(),
                minimum,
                maximum,
            ),
            InputSchemaKind::Number { minimum, maximum } => validate_numeric_value(
                path,
                value,
                InputValueType::Number,
                self.enum_values.as_deref(),
                minimum,
                maximum,
            ),
            InputSchemaKind::Boolean => {
                if value.is_boolean() {
                    validate_enum_value(path, value, self.enum_values.as_deref())
                } else {
                    Err(InputValidationError::new(
                        path,
                        InputErrorKind::TypeMismatch { expected: InputValueType::Boolean },
                    ))
                }
            }
            InputSchemaKind::Object { properties, required } => {
                let Some(object) = value.as_object() else {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::TypeMismatch { expected: InputValueType::Object },
                    ));
                };

                for key in required {
                    if !object.contains_key(key) {
                        return Err(InputValidationError::new(
                            join_object_field_path(Some(path), key),
                            InputErrorKind::MissingRequiredProperty,
                        ));
                    }
                }

                for (key, property_schema) in properties {
                    if let Some(property_value) = object.get(key) {
                        property_schema.validate_value(
                            &join_object_field_path(Some(path), key),
                            property_value,
                        )?;
                    }
                }

                validate_enum_value(path, value, self.enum_values.as_deref())
            }
            InputSchemaKind::Array { items, min_items, max_items } => {
                let Some(values) = value.as_array() else {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::TypeMismatch { expected: InputValueType::Array },
                    ));
                };

                if let Some(min_items) = min_items
                    && values.len() < *min_items
                {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::MinItemsViolation { min_items: *min_items },
                    ));
                }
                if let Some(max_items) = max_items
                    && values.len() > *max_items
                {
                    return Err(InputValidationError::new(
                        path,
                        InputErrorKind::MaxItemsViolation { max_items: *max_items },
                    ));
                }

                for (index, item_value) in values.iter().enumerate() {
                    items.validate_value(&join_array_field_path(Some(path), index), item_value)?;
                }
                validate_enum_value(path, value, self.enum_values.as_deref())
            }
        }
    }

    fn parse_inner(
        schema: &JsonValue,
        path: String,
        allow_default: bool,
    ) -> Result<Self, InputSchemaError> {
        let object = schema.as_object().ok_or_else(|| {
            InputSchemaError::new(path.clone(), "must be a JSON object schema".to_owned())
        })?;

        let schema_type = parse_input_type_keyword(object, &path)?;
        let description = parse_optional_string_keyword(object, &path, "description")?;
        let default = parse_default_keyword(object, &path, allow_default)?;
        let enum_values = parse_input_enum(object, &path, schema_type)?;

        let kind = match schema_type {
            InputValueType::String => InputSchemaKind::String {
                min_length: parse_optional_usize_keyword(object, &path, "minLength")?,
                max_length: parse_optional_usize_keyword(object, &path, "maxLength")?,
                pattern: parse_optional_pattern_keyword(object, &path)?,
            },
            InputValueType::Integer => InputSchemaKind::Integer {
                minimum: parse_optional_number_keyword(
                    object,
                    &path,
                    "minimum",
                    InputValueType::Integer,
                )?,
                maximum: parse_optional_number_keyword(
                    object,
                    &path,
                    "maximum",
                    InputValueType::Integer,
                )?,
            },
            InputValueType::Number => InputSchemaKind::Number {
                minimum: parse_optional_number_keyword(
                    object,
                    &path,
                    "minimum",
                    InputValueType::Number,
                )?,
                maximum: parse_optional_number_keyword(
                    object,
                    &path,
                    "maximum",
                    InputValueType::Number,
                )?,
            },
            InputValueType::Boolean => InputSchemaKind::Boolean,
            InputValueType::Object => {
                let properties = parse_input_properties(object, &path)?;
                let required = parse_required_keys(object, &path)
                    .map_err(InputSchemaError::from_required_error)?;
                if let Some(key) = find_unknown_required_property(&required, &properties) {
                    return Err(InputSchemaError::new(
                        format!("{path}.required"),
                        format!("references undeclared property `{key}`"),
                    ));
                }
                InputSchemaKind::Object { properties, required }
            }
            InputValueType::Array => InputSchemaKind::Array {
                items: Box::new(parse_array_items(object, &path)?),
                min_items: parse_optional_usize_keyword(object, &path, "minItems")?,
                max_items: parse_optional_usize_keyword(object, &path, "maxItems")?,
            },
        };

        validate_supported_input_keywords(object, &path, schema_type)?;
        validate_input_schema_constraints(&path, &kind)?;

        let schema = Self { description, default, enum_values, kind };
        schema.validate_declared_default(&path)?;
        Ok(schema)
    }

    fn validate_declared_default(&self, path: &str) -> Result<(), InputSchemaError> {
        let Some(default) = &self.default else {
            return Ok(());
        };
        self.validate_value(path, default).map_err(|error| {
            InputSchemaError::new(
                path.to_owned(),
                format!("has invalid `default`: {}", error.reason()),
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputSchemaError {
    pub path: String,
    message: String,
}

impl InputSchemaError {
    fn new(path: String, message: String) -> Self {
        Self { path, message }
    }

    fn from_required_error(error: RequiredKeyError) -> Self {
        Self::new(error.path, error.message)
    }
}

impl Display for InputSchemaError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "`{}` {}", self.path, self.message)
    }
}

impl std::error::Error for InputSchemaError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputPathError {
    path: String,
    kind: InputPathErrorKind,
}

impl InputPathError {
    fn new(path: impl Into<String>, kind: InputPathErrorKind) -> Self {
        Self { path: path.into(), kind }
    }
}

impl Display for InputPathError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self.kind {
            InputPathErrorKind::UnsupportedNestedFieldAccess => {
                write!(formatter, "`{}` does not support nested field access", self.path)
            }
            InputPathErrorKind::UndeclaredProperty => {
                write!(formatter, "`{}` is not declared", self.path)
            }
            InputPathErrorKind::ArrayIndexMustBeNumeric => {
                write!(formatter, "`{}` array access must use a numeric index", self.path)
            }
        }
    }
}

impl std::error::Error for InputPathError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputPathErrorKind {
    UnsupportedNestedFieldAccess,
    UndeclaredProperty,
    ArrayIndexMustBeNumeric,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputValidationError {
    pub path: String,
    pub kind: InputErrorKind,
}

impl InputValidationError {
    fn new(path: impl Into<String>, kind: InputErrorKind) -> Self {
        Self { path: path.into(), kind }
    }

    pub fn reason(&self) -> String {
        match &self.kind {
            InputErrorKind::TypeMismatch { expected } => {
                format!("must be {}", expected.as_str())
            }
            InputErrorKind::EnumViolation => "must be one of the declared enum values".to_owned(),
            InputErrorKind::MinimumViolation { minimum } => {
                format!("must be >= {minimum}")
            }
            InputErrorKind::MaximumViolation { maximum } => {
                format!("must be <= {maximum}")
            }
            InputErrorKind::MinLengthViolation { min_length } => {
                format!("must have length >= {min_length}")
            }
            InputErrorKind::MaxLengthViolation { max_length } => {
                format!("must have length <= {max_length}")
            }
            InputErrorKind::PatternViolation { pattern } => {
                format!("must match pattern `{pattern}`")
            }
            InputErrorKind::MissingRequiredProperty => "is required".to_owned(),
            InputErrorKind::MinItemsViolation { min_items } => {
                format!("must contain at least {min_items} item(s)")
            }
            InputErrorKind::MaxItemsViolation { max_items } => {
                format!("must contain at most {max_items} item(s)")
            }
        }
    }
}

impl Display for InputValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "`{}` {}", self.path, self.reason())
    }
}

impl std::error::Error for InputValidationError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputErrorKind {
    TypeMismatch { expected: InputValueType },
    EnumViolation,
    MinimumViolation { minimum: String },
    MaximumViolation { maximum: String },
    MinLengthViolation { min_length: usize },
    MaxLengthViolation { max_length: usize },
    PatternViolation { pattern: String },
    MissingRequiredProperty,
    MinItemsViolation { min_items: usize },
    MaxItemsViolation { max_items: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputSchema {
    Nullable(Box<OutputSchema>),
    String,
    Integer,
    Number,
    Boolean,
    Object { required: BTreeSet<String>, properties: BTreeMap<String, OutputSchema> },
    Array { items: Option<Box<OutputSchema>> },
}

impl OutputSchema {
    pub fn parse_at(
        schema: &JsonValue,
        root_path: impl Into<String>,
    ) -> Result<Self, OutputSchemaError> {
        Self::parse_inner(schema, root_path.into())
    }

    pub fn output_type(&self) -> OutputType {
        match self {
            Self::Nullable(inner) => inner.output_type(),
            Self::String => OutputType::String,
            Self::Integer => OutputType::Integer,
            Self::Number => OutputType::Number,
            Self::Boolean => OutputType::Boolean,
            Self::Object { .. } => OutputType::Object,
            Self::Array { .. } => OutputType::Array,
        }
    }

    pub fn result_shape(&self) -> ResultShape {
        match self {
            Self::Nullable(inner) => inner.result_shape(),
            Self::String => ResultShape::String,
            Self::Integer => ResultShape::Integer,
            Self::Number => ResultShape::Number,
            Self::Boolean => ResultShape::Boolean,
            Self::Object { properties, .. } => ResultShape::Object(
                properties
                    .iter()
                    .map(|(key, schema)| (key.clone(), schema.result_shape()))
                    .collect(),
            ),
            Self::Array { items } => ResultShape::Array {
                items: items.as_ref().map(|schema| Box::new(schema.result_shape())),
            },
        }
    }

    pub fn to_json_schema(&self) -> JsonValue {
        match self {
            Self::Nullable(inner) => {
                let mut schema = inner.to_json_schema();
                let JsonValue::Object(object) = &mut schema else {
                    unreachable!("output schemas always serialize to JSON objects");
                };
                let Some(type_value) = object.get_mut("type") else {
                    unreachable!("output schemas always serialize a `type` keyword");
                };
                *type_value = match type_value.clone() {
                    JsonValue::String(schema_type) => JsonValue::Array(vec![
                        JsonValue::String(schema_type),
                        JsonValue::String("null".to_owned()),
                    ]),
                    JsonValue::Array(mut schema_types) => {
                        if !schema_types.iter().any(|value| value == "null") {
                            schema_types.push(JsonValue::String("null".to_owned()));
                        }
                        JsonValue::Array(schema_types)
                    }
                    _ => unreachable!("output schema `type` must serialize as string or array"),
                };
                schema
            }
            Self::String | Self::Integer | Self::Number | Self::Boolean => {
                self.output_type().to_schema()
            }
            Self::Object { required, properties } => serde_json::json!({
                "type": "object",
                "properties": properties
                    .iter()
                    .map(|(key, schema)| (key.clone(), schema.to_json_schema()))
                    .collect::<JsonMap<_, _>>(),
                "required": required.iter().cloned().collect::<Vec<_>>(),
                "additionalProperties": false,
            }),
            Self::Array { items } => {
                let mut object = JsonMap::from_iter([(
                    "type".to_owned(),
                    JsonValue::String("array".to_owned()),
                )]);
                if let Some(items) = items {
                    object.insert("items".to_owned(), items.to_json_schema());
                }
                JsonValue::Object(object)
            }
        }
    }

    pub fn validate_value(
        &self,
        field_path: Option<&str>,
        value: &JsonValue,
    ) -> Result<(), ResultValidationError> {
        if let Self::Nullable(inner) = self {
            if value.is_null() {
                return Ok(());
            }
            return inner.validate_value(field_path, value);
        }

        let field_name = field_path.unwrap_or("result");
        let output_type = self.output_type();
        if !output_type.matches_json_value(value) {
            return Err(ResultValidationError::TypeMismatch {
                field: field_name.to_owned(),
                expected: output_type,
            });
        }

        match self {
            Self::Nullable(_) => unreachable!("nullable schemas are handled before matching"),
            Self::String | Self::Integer | Self::Number | Self::Boolean => Ok(()),
            Self::Object { required, properties } => {
                let Some(object) = value.as_object() else {
                    return Err(ResultValidationError::TypeMismatch {
                        field: field_name.to_owned(),
                        expected: output_type,
                    });
                };

                for key in required {
                    if !object.contains_key(key) {
                        return Err(ResultValidationError::MissingRequiredField {
                            field: join_object_field_path(field_path, key),
                        });
                    }
                }

                for (key, property_schema) in properties {
                    if let Some(property_value) = object.get(key) {
                        let property_path = join_object_field_path(field_path, key);
                        property_schema
                            .validate_value(Some(property_path.as_str()), property_value)?;
                    }
                }

                Ok(())
            }
            Self::Array { items } => {
                let Some(item_schema) = items else {
                    return Ok(());
                };
                let Some(values) = value.as_array() else {
                    return Err(ResultValidationError::TypeMismatch {
                        field: field_name.to_owned(),
                        expected: output_type,
                    });
                };

                for (index, item_value) in values.iter().enumerate() {
                    let item_path = join_array_field_path(field_path, index);
                    item_schema.validate_value(Some(item_path.as_str()), item_value)?;
                }

                Ok(())
            }
        }
    }

    fn parse_inner(schema: &JsonValue, path: String) -> Result<Self, OutputSchemaError> {
        let object = schema.as_object().ok_or_else(|| OutputSchemaError {
            path: path.clone(),
            kind: OutputSchemaErrorKind::ExpectedObject,
        })?;

        let (schema_type, nullable) = parse_output_type_keyword(object, &path)?;

        let schema = match schema_type {
            "string" => Ok(Self::String),
            "integer" => Ok(Self::Integer),
            "number" => Ok(Self::Number),
            "boolean" => Ok(Self::Boolean),
            "object" => {
                let properties_value =
                    object.get("properties").ok_or_else(|| OutputSchemaError {
                        path: path.clone(),
                        kind: OutputSchemaErrorKind::MissingProperties,
                    })?;
                let properties = properties_value.as_object().ok_or_else(|| OutputSchemaError {
                    path: format!("{path}.properties"),
                    kind: OutputSchemaErrorKind::InvalidProperties,
                })?;

                let properties = properties
                    .iter()
                    .map(|(key, property_schema)| {
                        Self::parse_inner(property_schema, format!("{path}.properties.{key}"))
                            .map(|schema| (key.clone(), schema))
                    })
                    .collect::<Result<BTreeMap<_, _>, _>>()?;

                let required = parse_required_keys(object, &path)
                    .map_err(OutputSchemaError::from_required_error)?;
                if let Some(key) = find_unknown_required_property(&required, &properties) {
                    return Err(OutputSchemaError {
                        path: format!("{path}.required"),
                        kind: OutputSchemaErrorKind::UnknownRequiredProperty {
                            key: key.to_owned(),
                        },
                    });
                }

                Ok(Self::Object { required, properties })
            }
            "array" => {
                let items = object
                    .get("items")
                    .map(|item_schema| {
                        Self::parse_inner(item_schema, format!("{path}.items")).map(Box::new)
                    })
                    .transpose()?;
                Ok(Self::Array { items })
            }
            other => Err(OutputSchemaError {
                path,
                kind: OutputSchemaErrorKind::UnsupportedType { schema_type: other.to_owned() },
            }),
        }?;

        if nullable { Ok(Self::Nullable(Box::new(schema))) } else { Ok(schema) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSchemaError {
    pub path: String,
    pub kind: OutputSchemaErrorKind,
}

impl OutputSchemaError {
    fn from_required_error(error: RequiredKeyError) -> Self {
        Self {
            path: error.path,
            kind: OutputSchemaErrorKind::RequiredError { message: error.message },
        }
    }
}

impl Display for OutputSchemaError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            OutputSchemaErrorKind::ExpectedObject => {
                write!(formatter, "`{}` must be a JSON object schema", self.path)
            }
            OutputSchemaErrorKind::MissingType => {
                write!(formatter, "`{}` must declare a supported `type`", self.path)
            }
            OutputSchemaErrorKind::UnsupportedType { schema_type } => {
                write!(formatter, "`{}` uses unsupported schema type `{schema_type}`", self.path)
            }
            OutputSchemaErrorKind::MissingProperties => write!(
                formatter,
                "`{}` with `type: object` must declare a `properties` object",
                self.path
            ),
            OutputSchemaErrorKind::InvalidProperties => {
                write!(formatter, "`{}` must be an object", self.path)
            }
            OutputSchemaErrorKind::UnknownRequiredProperty { key } => {
                write!(formatter, "`{}` references undeclared property `{key}`", self.path)
            }
            OutputSchemaErrorKind::RequiredError { message } => {
                write!(formatter, "`{}` {}", self.path, message)
            }
        }
    }
}

impl std::error::Error for OutputSchemaError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputSchemaErrorKind {
    ExpectedObject,
    MissingType,
    UnsupportedType { schema_type: String },
    MissingProperties,
    InvalidProperties,
    UnknownRequiredProperty { key: String },
    RequiredError { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultValidationError {
    MissingRequiredField { field: String },
    TypeMismatch { field: String, expected: OutputType },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequiredKeyError {
    path: String,
    message: String,
}

fn validate_numeric_value(
    path: &str,
    value: &JsonValue,
    expected: InputValueType,
    enum_values: Option<&[JsonValue]>,
    minimum: &Option<JsonNumber>,
    maximum: &Option<JsonNumber>,
) -> Result<(), InputValidationError> {
    if !input_value_matches_type(value, expected) {
        return Err(InputValidationError::new(path, InputErrorKind::TypeMismatch { expected }));
    }

    let Some(value_number) = value.as_number() else {
        return Err(InputValidationError::new(path, InputErrorKind::TypeMismatch { expected }));
    };

    if let Some(minimum) = minimum
        && compare_json_numbers(value_number, minimum) == Ordering::Less
    {
        return Err(InputValidationError::new(
            path,
            InputErrorKind::MinimumViolation { minimum: number_to_string(minimum) },
        ));
    }
    if let Some(maximum) = maximum
        && compare_json_numbers(value_number, maximum) == Ordering::Greater
    {
        return Err(InputValidationError::new(
            path,
            InputErrorKind::MaximumViolation { maximum: number_to_string(maximum) },
        ));
    }

    validate_enum_value(path, value, enum_values)
}

fn validate_enum_value(
    path: &str,
    value: &JsonValue,
    enum_values: Option<&[JsonValue]>,
) -> Result<(), InputValidationError> {
    let Some(enum_values) = enum_values else {
        return Ok(());
    };

    if enum_values.iter().any(|candidate| input_json_values_equal(candidate, value)) {
        Ok(())
    } else {
        Err(InputValidationError::new(path, InputErrorKind::EnumViolation))
    }
}

fn parse_input_type_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
) -> Result<InputValueType, InputSchemaError> {
    let schema_type = object.get("type").and_then(JsonValue::as_str).ok_or_else(|| {
        InputSchemaError::new(path.to_owned(), "must declare a supported `type`".to_owned())
    })?;

    match schema_type {
        "string" => Ok(InputValueType::String),
        "integer" => Ok(InputValueType::Integer),
        "number" => Ok(InputValueType::Number),
        "boolean" => Ok(InputValueType::Boolean),
        "object" => Ok(InputValueType::Object),
        "array" => Ok(InputValueType::Array),
        _ => Err(InputSchemaError::new(
            path.to_owned(),
            format!("uses unsupported schema type `{schema_type}`"),
        )),
    }
}

fn parse_output_type_keyword<'a>(
    object: &'a JsonMap<String, JsonValue>,
    path: &str,
) -> Result<(&'a str, bool), OutputSchemaError> {
    let type_value = object.get("type").ok_or_else(|| OutputSchemaError {
        path: path.to_owned(),
        kind: OutputSchemaErrorKind::MissingType,
    })?;

    match type_value {
        JsonValue::String(schema_type) => Ok((schema_type.as_str(), false)),
        JsonValue::Array(schema_types) => {
            let mut nullable = false;
            let mut base_type: Option<&str> = None;

            for schema_type in schema_types {
                let schema_type = schema_type.as_str().ok_or_else(|| OutputSchemaError {
                    path: format!("{path}.type"),
                    kind: OutputSchemaErrorKind::UnsupportedType {
                        schema_type: type_value.to_string(),
                    },
                })?;
                if schema_type == "null" {
                    nullable = true;
                    continue;
                }
                if base_type.replace(schema_type).is_some() {
                    return Err(OutputSchemaError {
                        path: format!("{path}.type"),
                        kind: OutputSchemaErrorKind::UnsupportedType {
                            schema_type: type_value.to_string(),
                        },
                    });
                }
            }

            let Some(base_type) = base_type else {
                return Err(OutputSchemaError {
                    path: format!("{path}.type"),
                    kind: OutputSchemaErrorKind::UnsupportedType {
                        schema_type: type_value.to_string(),
                    },
                });
            };
            Ok((base_type, nullable))
        }
        _ => Err(OutputSchemaError {
            path: path.to_owned(),
            kind: OutputSchemaErrorKind::MissingType,
        }),
    }
}

fn parse_default_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    allow_default: bool,
) -> Result<Option<JsonValue>, InputSchemaError> {
    let Some(default) = object.get("default") else {
        return Ok(None);
    };
    if allow_default {
        Ok(Some(default.clone()))
    } else {
        Err(InputSchemaError::new(
            format!("{path}.default"),
            "is not supported for nested input schemas".to_owned(),
        ))
    }
}

fn parse_optional_string_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    keyword: &str,
) -> Result<Option<String>, InputSchemaError> {
    let Some(value) = object.get(keyword) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            InputSchemaError::new(format!("{path}.{keyword}"), "must be a string".to_owned())
        })
        .map(Some)
}

fn parse_optional_pattern_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
) -> Result<Option<InputPattern>, InputSchemaError> {
    parse_optional_string_keyword(object, path, "pattern")?
        .map(|pattern| InputPattern::parse(path, &pattern))
        .transpose()
}

fn parse_optional_usize_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    keyword: &str,
) -> Result<Option<usize>, InputSchemaError> {
    let Some(value) = object.get(keyword) else {
        return Ok(None);
    };
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            InputSchemaError::new(
                format!("{path}.{keyword}"),
                "must be a non-negative integer".to_owned(),
            )
        })
        .map(Some)
}

fn parse_optional_number_keyword(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    keyword: &str,
    expected: InputValueType,
) -> Result<Option<JsonNumber>, InputSchemaError> {
    let Some(value) = object.get(keyword) else {
        return Ok(None);
    };

    match expected {
        InputValueType::Integer => value
            .as_number()
            .filter(|number| json_number_matches_integer_semantics(number))
            .cloned()
            .ok_or_else(|| {
                InputSchemaError::new(format!("{path}.{keyword}"), "must be an integer".to_owned())
            })
            .map(Some),
        InputValueType::Number => value
            .as_number()
            .cloned()
            .ok_or_else(|| {
                InputSchemaError::new(format!("{path}.{keyword}"), "must be a number".to_owned())
            })
            .map(Some),
        _ => unreachable!("numeric keyword used for non-numeric schema"),
    }
}

fn parse_input_enum(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    expected: InputValueType,
) -> Result<Option<Vec<JsonValue>>, InputSchemaError> {
    let Some(value) = object.get("enum") else {
        return Ok(None);
    };
    let values = value.as_array().ok_or_else(|| {
        InputSchemaError::new(
            format!("{path}.enum"),
            format!("must be an array of {}", enum_value_description(expected)),
        )
    })?;

    values
        .iter()
        .map(|value| {
            if input_value_matches_type(value, expected) {
                Ok(value.clone())
            } else {
                Err(InputSchemaError::new(
                    format!("{path}.enum"),
                    format!("must be an array of {}", enum_value_description(expected)),
                ))
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn enum_value_description(expected: InputValueType) -> &'static str {
    match expected {
        InputValueType::String => "strings",
        InputValueType::Integer => "integer",
        InputValueType::Number => "number",
        InputValueType::Boolean => "boolean",
        InputValueType::Object => "object",
        InputValueType::Array => "array",
    }
}

fn parse_input_properties(
    object: &JsonMap<String, JsonValue>,
    path: &str,
) -> Result<BTreeMap<String, InputSchema>, InputSchemaError> {
    let properties_value = object.get("properties").ok_or_else(|| {
        InputSchemaError::new(
            path.to_owned(),
            "with `type: object` must declare a `properties` object".to_owned(),
        )
    })?;
    let properties = properties_value.as_object().ok_or_else(|| {
        InputSchemaError::new(format!("{path}.properties"), "must be an object".to_owned())
    })?;

    properties
        .iter()
        .map(|(key, property_schema)| {
            InputSchema::parse_inner(property_schema, format!("{path}.properties.{key}"), false)
                .map(|schema| (key.clone(), schema))
        })
        .collect()
}

fn parse_array_items(
    object: &JsonMap<String, JsonValue>,
    path: &str,
) -> Result<InputSchema, InputSchemaError> {
    let items_value = object.get("items").ok_or_else(|| {
        InputSchemaError::new(
            path.to_owned(),
            "with `type: array` must declare an `items` schema".to_owned(),
        )
    })?;
    InputSchema::parse_inner(items_value, format!("{path}.items"), false)
}

fn validate_supported_input_keywords(
    object: &JsonMap<String, JsonValue>,
    path: &str,
    schema_type: InputValueType,
) -> Result<(), InputSchemaError> {
    let allowed = match schema_type {
        InputValueType::String => {
            &["type", "description", "default", "enum", "minLength", "maxLength", "pattern"][..]
        }
        InputValueType::Integer | InputValueType::Number => {
            &["type", "description", "default", "enum", "minimum", "maximum"][..]
        }
        InputValueType::Boolean => &["type", "description", "default", "enum"][..],
        InputValueType::Object => {
            &["type", "description", "default", "enum", "properties", "required"][..]
        }
        InputValueType::Array => {
            &["type", "description", "default", "enum", "items", "minItems", "maxItems"][..]
        }
    };

    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(InputSchemaError::new(
                format!("{path}.{key}"),
                "uses an unsupported keyword".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_input_schema_constraints(
    path: &str,
    kind: &InputSchemaKind,
) -> Result<(), InputSchemaError> {
    match kind {
        InputSchemaKind::String { min_length, max_length, .. } => {
            if let (Some(min_length), Some(max_length)) = (min_length, max_length)
                && min_length > max_length
            {
                return Err(InputSchemaError::new(
                    path.to_owned(),
                    "`minLength` cannot be greater than `maxLength`".to_owned(),
                ));
            }
        }
        InputSchemaKind::Integer { minimum, maximum, .. }
        | InputSchemaKind::Number { minimum, maximum, .. } => {
            if let (Some(minimum), Some(maximum)) = (minimum, maximum)
                && compare_json_numbers(minimum, maximum) == Ordering::Greater
            {
                return Err(InputSchemaError::new(
                    path.to_owned(),
                    "`minimum` cannot be greater than `maximum`".to_owned(),
                ));
            }
        }
        InputSchemaKind::Array { min_items, max_items, .. } => {
            if let (Some(min_items), Some(max_items)) = (min_items, max_items)
                && min_items > max_items
            {
                return Err(InputSchemaError::new(
                    path.to_owned(),
                    "`minItems` cannot be greater than `maxItems`".to_owned(),
                ));
            }
        }
        InputSchemaKind::Boolean | InputSchemaKind::Object { .. } => {}
    }
    Ok(())
}

fn parse_required_keys(
    object: &JsonMap<String, JsonValue>,
    path: &str,
) -> Result<BTreeSet<String>, RequiredKeyError> {
    let Some(required) = object.get("required") else {
        return Ok(BTreeSet::new());
    };
    let required_path = format!("{path}.required");
    let required = required.as_array().ok_or_else(|| RequiredKeyError {
        path: required_path.clone(),
        message: "must be an array of strings".to_owned(),
    })?;

    let mut keys = BTreeSet::new();
    for key in required {
        let key = key.as_str().ok_or_else(|| RequiredKeyError {
            path: required_path.clone(),
            message: "must be an array of strings".to_owned(),
        })?;
        keys.insert(key.to_owned());
    }

    Ok(keys)
}

fn find_unknown_required_property<'a, T>(
    required: &'a BTreeSet<String>,
    properties: &BTreeMap<String, T>,
) -> Option<&'a str> {
    required.iter().find(|key| !properties.contains_key(*key)).map(String::as_str)
}

fn compare_json_numbers(left: &JsonNumber, right: &JsonNumber) -> Ordering {
    NormalizedJsonNumber::parse(left).cmp(&NormalizedJsonNumber::parse(right))
}

fn input_value_matches_type(value: &JsonValue, expected: InputValueType) -> bool {
    match expected {
        InputValueType::String => value.is_string(),
        InputValueType::Integer => {
            value.as_number().is_some_and(json_number_matches_integer_semantics)
        }
        InputValueType::Number => value.is_number(),
        InputValueType::Boolean => value.is_boolean(),
        InputValueType::Object => value.is_object(),
        InputValueType::Array => value.is_array(),
    }
}

fn input_json_values_equal(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Null, JsonValue::Null) => true,
        (JsonValue::Bool(left), JsonValue::Bool(right)) => left == right,
        (JsonValue::String(left), JsonValue::String(right)) => left == right,
        (JsonValue::Number(left), JsonValue::Number(right)) => {
            compare_json_numbers(left, right) == Ordering::Equal
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right.iter())
                    .all(|(left_item, right_item)| input_json_values_equal(left_item, right_item))
        }
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left_value)| {
                    right
                        .get(key)
                        .is_some_and(|right_value| input_json_values_equal(left_value, right_value))
                })
        }
        _ => false,
    }
}

fn json_number_matches_integer_semantics(number: &JsonNumber) -> bool {
    NormalizedJsonNumber::parse(number).is_integer()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedJsonNumber {
    sign: i8,
    digits: String,
    exponent: i64,
}

impl NormalizedJsonNumber {
    fn parse(number: &JsonNumber) -> Self {
        Self::parse_str(&number.to_string())
    }

    fn parse_str(raw: &str) -> Self {
        let (negative, raw) = match raw.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, raw),
        };
        let (mantissa, exponent) = match raw.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => match exponent.parse::<i64>() {
                Ok(exponent) => (mantissa, exponent),
                Err(_) => panic!("serde_json::Number must stringify to a valid JSON number"),
            },
            None => (raw, 0),
        };
        let (integer, fractional) = match mantissa.split_once('.') {
            Some((integer, fractional)) => (integer, fractional),
            None => (mantissa, ""),
        };
        if integer.is_empty() && fractional.is_empty() {
            panic!("serde_json::Number must stringify to a valid JSON number");
        }
        if !integer.bytes().all(|byte| byte.is_ascii_digit())
            || !fractional.bytes().all(|byte| byte.is_ascii_digit())
        {
            panic!("serde_json::Number must stringify to a valid JSON number");
        }

        let mut digits = String::with_capacity(integer.len() + fractional.len());
        digits.push_str(integer);
        digits.push_str(fractional);

        let first_non_zero = digits.bytes().position(|byte| byte != b'0');
        let Some(first_non_zero) = first_non_zero else {
            return Self { sign: 0, digits: "0".to_owned(), exponent: 0 };
        };
        digits.drain(..first_non_zero);

        let mut normalized_exponent = exponent - fractional.len() as i64;
        while digits.len() > 1 && digits.ends_with('0') {
            digits.pop();
            normalized_exponent += 1;
        }

        Self { sign: if negative { -1 } else { 1 }, digits, exponent: normalized_exponent }
    }

    fn is_integer(&self) -> bool {
        self.sign == 0 || self.exponent >= 0
    }

    fn compare_magnitude(&self, other: &Self) -> Ordering {
        let min_exponent = self.exponent.min(other.exponent);
        let self_zero_padding = (self.exponent - min_exponent) as usize;
        let other_zero_padding = (other.exponent - min_exponent) as usize;
        let self_len = self.digits.len() + self_zero_padding;
        let other_len = other.digits.len() + other_zero_padding;

        match self_len.cmp(&other_len) {
            Ordering::Equal => compare_digit_sequences(
                self.digits.as_bytes(),
                self_zero_padding,
                other.digits.as_bytes(),
                other_zero_padding,
            ),
            ordering => ordering,
        }
    }
}

impl Ord for NormalizedJsonNumber {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.sign.cmp(&other.sign) {
            Ordering::Equal => match self.sign {
                -1 => self.compare_magnitude(other).reverse(),
                0 => Ordering::Equal,
                1 => self.compare_magnitude(other),
                _ => unreachable!("normalized JSON number sign must be -1, 0, or 1"),
            },
            ordering => ordering,
        }
    }
}

impl PartialOrd for NormalizedJsonNumber {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_digit_sequences(
    left_digits: &[u8],
    left_zero_padding: usize,
    right_digits: &[u8],
    right_zero_padding: usize,
) -> Ordering {
    let left_len = left_digits.len() + left_zero_padding;
    let right_len = right_digits.len() + right_zero_padding;

    debug_assert_eq!(left_len, right_len);

    for index in 0..left_len {
        let left = if index < left_digits.len() { left_digits[index] } else { b'0' };
        let right = if index < right_digits.len() { right_digits[index] } else { b'0' };
        match left.cmp(&right) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    Ordering::Equal
}

fn number_to_string(number: &JsonNumber) -> String {
    number
        .as_i64()
        .map(|value| value.to_string())
        .or_else(|| number.as_u64().map(|value| value.to_string()))
        .or_else(|| number.as_f64().map(|value| value.to_string()))
        .unwrap_or_else(|| number.to_string())
}

fn join_object_field_path(prefix: Option<&str>, key: &str) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}.{key}"),
        None => key.to_owned(),
    }
}

fn join_array_field_path(prefix: Option<&str>, index: usize) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}[{index}]"),
        None => format!("[{index}]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check_parse_error(
        schema_json: serde_json::Value,
        path: &str,
        check: impl FnOnce(InputSchemaError),
    ) {
        let error =
            InputSchema::parse_at(&schema_json, path).expect_err("schema should be rejected");
        check(error);
    }

    fn check_validation_error(
        schema_json: serde_json::Value,
        path: &str,
        field_name: &str,
        rejected: serde_json::Value,
        check: impl FnOnce(InputValidationError),
    ) -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(&schema_json, path)?;
        let error = schema
            .validate_and_normalize(Some(field_name), &rejected)
            .expect_err("value should be rejected");
        check(error);
        Ok(())
    }

    #[test]
    fn rejects_undeclared_required_properties() {
        check_parse_error(
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" }
                },
                "required": ["email"]
            }),
            "workflow.inputs.user",
            |error| {
                assert_eq!(error.path, "workflow.inputs.user.required");
                assert_eq!(
                    error.to_string(),
                    "`workflow.inputs.user.required` references undeclared property `email`"
                );
            },
        );
    }

    #[test]
    fn integer_schema_rejects_large_reversed_bounds() {
        check_parse_error(
            json!({
                "type": "integer",
                "minimum": 18446744073709551615u64,
                "maximum": 18446744073709551614u64
            }),
            "workflow.inputs.count",
            |error| {
                assert_eq!(error.path, "workflow.inputs.count");
                assert_eq!(
                    error.to_string(),
                    "`workflow.inputs.count` `minimum` cannot be greater than `maximum`"
                );
            },
        );
    }

    #[test]
    fn integer_schema_rejects_values_above_large_maximum() -> Result<(), Box<dyn std::error::Error>>
    {
        check_validation_error(
            json!({
                "type": "integer",
                "maximum": 18446744073709551614u64
            }),
            "workflow.inputs.count",
            "count",
            json!(18446744073709551615u64),
            |error| {
                assert_eq!(error.path, "count");
                assert_eq!(
                    error.kind,
                    InputErrorKind::MaximumViolation { maximum: "18446744073709551614".to_owned() }
                );
            },
        )
    }

    #[test]
    fn number_schema_preserves_large_integer_bounds() -> Result<(), Box<dyn std::error::Error>> {
        check_validation_error(
            json!({
                "type": "number",
                "maximum": 18446744073709551614u64
            }),
            "workflow.inputs.count",
            "count",
            json!(18446744073709551615u64),
            |error| {
                assert_eq!(error.path, "count");
                assert_eq!(
                    error.kind,
                    InputErrorKind::MaximumViolation { maximum: "18446744073709551614".to_owned() }
                );
            },
        )
    }

    fn check_enum_validation(
        schema_json: serde_json::Value,
        path: &str,
        field_name: &str,
        accepted: serde_json::Value,
        rejected: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(&schema_json, path)?;
        assert_eq!(schema.validate_and_normalize(Some(field_name), &accepted)?, accepted);
        check_validation_error(schema_json, path, field_name, rejected, |error| {
            assert_eq!(error.path, field_name);
            assert_eq!(error.kind, InputErrorKind::EnumViolation);
        })
    }

    #[test]
    fn boolean_schema_supports_enum() -> Result<(), Box<dyn std::error::Error>> {
        check_enum_validation(
            json!({
                "type": "boolean",
                "enum": [true]
            }),
            "workflow.inputs.enabled",
            "enabled",
            json!(true),
            json!(false),
        )
    }

    #[test]
    fn object_schema_supports_enum() -> Result<(), Box<dyn std::error::Error>> {
        check_enum_validation(
            json!({
                "type": "object",
                "properties": {
                    "enabled": { "type": "boolean" }
                },
                "required": ["enabled"],
                "enum": [
                    { "enabled": true }
                ]
            }),
            "workflow.inputs.options",
            "options",
            json!({ "enabled": true }),
            json!({ "enabled": false }),
        )
    }

    #[test]
    fn array_schema_supports_enum() -> Result<(), Box<dyn std::error::Error>> {
        check_enum_validation(
            json!({
                "type": "array",
                "items": { "type": "integer" },
                "enum": [[1, 2]]
            }),
            "workflow.inputs.counts",
            "counts",
            json!([1, 2]),
            json!([2, 1]),
        )
    }

    #[test]
    fn number_enum_accepts_equivalent_numeric_literals() -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(
            &json!({
                "type": "number",
                "enum": [1]
            }),
            "workflow.inputs.count",
        )?;

        assert_eq!(schema.validate_and_normalize(Some("count"), &json!(1.0))?, json!(1.0));
        Ok(())
    }

    #[test]
    fn integer_accepts_equivalent_numeric_literals() -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(
            &serde_json::from_str::<JsonValue>(
                r#"{
                    "type": "integer",
                    "minimum": 1.0,
                    "maximum": 2e0,
                    "default": 1e0,
                    "enum": [1, 2.0]
                }"#,
            )?,
            "workflow.inputs.count",
        )?;

        let default = schema.default().ok_or("default should be present")?;
        assert_eq!(default, &serde_json::from_str::<JsonValue>("1e0")?);
        assert_eq!(
            schema.validate_and_normalize(
                Some("count"),
                &serde_json::from_str::<JsonValue>("2.0")?
            )?,
            serde_json::from_str::<JsonValue>("2.0")?
        );
        Ok(())
    }

    #[test]
    fn object_enum_uses_numeric_equality_recursively() -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(
            &json!({
                "type": "object",
                "properties": {
                    "count": { "type": "integer" }
                },
                "required": ["count"],
                "enum": [
                    { "count": 1 }
                ]
            }),
            "workflow.inputs.options",
        )?;

        assert_eq!(
            schema.validate_and_normalize(
                Some("options"),
                &serde_json::from_str::<JsonValue>(r#"{ "count": 1.0 }"#)?,
            )?,
            serde_json::from_str::<JsonValue>(r#"{ "count": 1.0 }"#)?
        );
        Ok(())
    }

    #[test]
    fn array_enum_uses_numeric_equality_recursively() -> Result<(), Box<dyn std::error::Error>> {
        let schema = InputSchema::parse_at(
            &json!({
                "type": "array",
                "items": { "type": "integer" },
                "enum": [[1]]
            }),
            "workflow.inputs.counts",
        )?;

        assert_eq!(
            schema.validate_and_normalize(
                Some("counts"),
                &serde_json::from_str::<JsonValue>("[1.0]")?,
            )?,
            serde_json::from_str::<JsonValue>("[1.0]")?
        );
        Ok(())
    }

    #[test]
    fn output_schema_supports_nullable_types() -> Result<(), Box<dyn std::error::Error>> {
        let schema = OutputSchema::parse_at(
            &json!({
                "type": ["integer", "null"]
            }),
            "workflow.result.priority",
        )?;

        schema.validate_value(Some("priority"), &json!(1)).expect("integer should be accepted");
        schema.validate_value(Some("priority"), &JsonValue::Null).expect("null should be accepted");
        assert_eq!(schema.result_shape(), ResultShape::Integer);
        assert_eq!(schema.to_json_schema(), json!({ "type": ["integer", "null"] }));

        let error = schema
            .validate_value(Some("priority"), &json!("high"))
            .expect_err("string should be rejected");
        assert_eq!(
            error,
            ResultValidationError::TypeMismatch {
                field: "priority".to_owned(),
                expected: OutputType::Integer,
            }
        );
        Ok(())
    }
}
