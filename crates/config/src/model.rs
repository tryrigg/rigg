use serde::Deserialize;
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
pub(crate) struct RawFlowFile {
    pub flows: BTreeMap<String, RawFlow>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawFlow {
    pub location: SourceLocation,
    pub inputs: BTreeMap<String, JsonValue>,
    pub env: BTreeMap<String, String>,
    pub steps: Vec<RawStep>,
    pub r#loop: Option<RawLoop>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawStep {
    pub location: SourceLocation,
    pub id: Option<String>,
    pub step_type: String,
    pub with: Option<JsonValue>,
    pub if_expr: Option<String>,
    pub env: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawLoop {
    pub location: SourceLocation,
    pub until: String,
    pub max: u32,
}

impl RawFlowFile {
    pub(crate) fn parse(contents: &str) -> Result<Self, serde_saphyr::Error> {
        #[derive(Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawFlowFile {
            flows: BTreeMap<String, Spanned<ParsedRawFlow>>,
        }

        #[derive(Debug, Clone, PartialEq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawFlow {
            #[serde(default)]
            inputs: BTreeMap<String, JsonValue>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            steps: Vec<Spanned<ParsedRawStep>>,
            #[serde(default)]
            r#loop: Option<Spanned<ParsedRawLoop>>,
        }

        #[derive(Debug, Clone, PartialEq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawStep {
            #[serde(default)]
            id: Option<String>,
            #[serde(rename = "type")]
            step_type: String,
            #[serde(default)]
            with: Option<JsonValue>,
            #[serde(rename = "if", default)]
            if_expr: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            #[serde(default)]
            outputs: BTreeMap<String, JsonValue>,
        }

        #[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ParsedRawLoop {
            until: String,
            max: u32,
        }

        let parsed: ParsedRawFlowFile = serde_saphyr::from_str(contents)?;
        Ok(Self {
            flows: parsed
                .flows
                .into_iter()
                .map(|(name, flow)| {
                    (
                        name,
                        RawFlow {
                            location: flow.referenced.into(),
                            inputs: flow.value.inputs,
                            env: flow.value.env,
                            steps: flow
                                .value
                                .steps
                                .into_iter()
                                .map(|step| RawStep {
                                    location: step.referenced.into(),
                                    id: step.value.id,
                                    step_type: step.value.step_type,
                                    with: step.value.with,
                                    if_expr: step.value.if_expr,
                                    env: step.value.env,
                                    outputs: step.value.outputs,
                                })
                                .collect(),
                            r#loop: flow.value.r#loop.map(|loop_config| RawLoop {
                                location: loop_config.referenced.into(),
                                until: loop_config.value.until,
                                max: loop_config.value.max,
                            }),
                        },
                    )
                })
                .collect(),
        })
    }
}
