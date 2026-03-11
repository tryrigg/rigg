use serde::{Deserialize, Deserializer};
use serde_json::Value as JsonValue;
use serde_saphyr::{Location, Spanned};
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDiscovery {
    pub project_root: PathBuf,
    pub rigg_dir: PathBuf,
    pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SourceLocation {
    pub line: u64,
    pub column: u64,
}

impl From<Location> for SourceLocation {
    fn from(value: Location) -> Self {
        Self { line: value.line(), column: value.column() }
    }
}

impl Display for SourceLocation {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        if self.line == 0 || self.column == 0 {
            formatter.write_str("unknown")
        } else {
            write!(formatter, "{}:{}", self.line, self.column)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawWorkflowFile {
    pub id: String,
    pub workflow: RawWorkflow,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawWorkflow {
    pub location: SourceLocation,
    pub inputs: BTreeMap<String, JsonValue>,
    pub env: BTreeMap<String, String>,
    pub steps: Vec<RawNode>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawNode {
    pub location: SourceLocation,
    pub id: Option<String>,
    pub node_type: String,
    pub with: Option<JsonValue>,
    pub if_expr: Option<String>,
    pub env: BTreeMap<String, String>,
    pub steps: Vec<RawNode>,
    pub cases: Vec<RawCase>,
    pub branches: Vec<RawParallelBranch>,
    pub exports: BTreeMap<String, String>,
    pub until: Option<String>,
    pub max: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawCase {
    pub location: SourceLocation,
    pub if_expr: Option<String>,
    pub is_else: bool,
    pub steps: Vec<RawNode>,
    pub exports: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawParallelBranch {
    pub location: SourceLocation,
    pub id: Option<String>,
    pub steps: Vec<RawNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct ElseMarker(bool);

impl RawWorkflowFile {
    pub(crate) fn parse(contents: &str) -> Result<Self, serde_saphyr::Error> {
        #[derive(Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawWorkflowFile {
            id: Spanned<String>,
            #[serde(default)]
            inputs: BTreeMap<String, JsonValue>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            steps: Vec<Spanned<ParsedRawNode>>,
        }

        #[derive(Debug, Clone, PartialEq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawNode {
            #[serde(default)]
            id: Option<String>,
            #[serde(rename = "type")]
            node_type: String,
            #[serde(default)]
            with: Option<JsonValue>,
            #[serde(rename = "if", default)]
            if_expr: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            #[serde(default)]
            steps: Vec<Spanned<ParsedRawNode>>,
            #[serde(default)]
            cases: Vec<Spanned<ParsedRawCase>>,
            #[serde(default)]
            branches: Vec<Spanned<ParsedRawParallelBranch>>,
            #[serde(default)]
            exports: BTreeMap<String, String>,
            #[serde(default)]
            until: Option<String>,
            #[serde(default)]
            max: Option<u32>,
        }

        #[derive(Debug, Clone, PartialEq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawCase {
            #[serde(rename = "if", default)]
            if_expr: Option<String>,
            #[serde(rename = "else", default)]
            else_marker: ElseMarker,
            #[serde(default)]
            steps: Vec<Spanned<ParsedRawNode>>,
            #[serde(default)]
            exports: BTreeMap<String, String>,
        }

        #[derive(Debug, Clone, PartialEq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawParallelBranch {
            id: Option<String>,
            #[serde(default)]
            steps: Vec<Spanned<ParsedRawNode>>,
        }

        fn convert_node(node: Spanned<ParsedRawNode>) -> RawNode {
            RawNode {
                location: node.referenced.into(),
                id: node.value.id,
                node_type: node.value.node_type,
                with: node.value.with,
                if_expr: node.value.if_expr,
                env: node.value.env,
                steps: node.value.steps.into_iter().map(convert_node).collect(),
                cases: node
                    .value
                    .cases
                    .into_iter()
                    .map(|case| RawCase {
                        location: case.referenced.into(),
                        if_expr: case.value.if_expr,
                        is_else: case.value.else_marker.0,
                        steps: case.value.steps.into_iter().map(convert_node).collect(),
                        exports: case.value.exports,
                    })
                    .collect(),
                branches: node
                    .value
                    .branches
                    .into_iter()
                    .map(|branch| RawParallelBranch {
                        location: branch.referenced.into(),
                        id: branch.value.id,
                        steps: branch.value.steps.into_iter().map(convert_node).collect(),
                    })
                    .collect(),
                exports: node.value.exports,
                until: node.value.until,
                max: node.value.max,
            }
        }

        let parsed: ParsedRawWorkflowFile = serde_saphyr::from_str(contents)?;
        Ok(Self {
            id: parsed.id.value,
            workflow: RawWorkflow {
                location: parsed.id.referenced.into(),
                inputs: parsed.inputs,
                env: parsed.env,
                steps: parsed.steps.into_iter().map(convert_node).collect(),
            },
        })
    }
}

impl<'de> Deserialize<'de> for ElseMarker {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match JsonValue::deserialize(deserializer)? {
            JsonValue::Null => Ok(Self(true)),
            _ => Err(serde::de::Error::custom("`else` must be empty")),
        }
    }
}
