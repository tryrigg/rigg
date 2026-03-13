mod action;
mod schema;

pub use action::{
    ActionKind, ActionNode, ClaudeStep, CodexAction, CodexExec, CodexMode, CodexReview, CodexStep,
    PermissionMode, Persistence, ResultContract, ReviewScope, ShellOutput, ShellStep,
    WriteFileStep, codex_review_result_schema,
};
pub use schema::{
    InputErrorKind, InputPathError, InputSchema, InputSchemaError, InputValidationError,
    InputValueType, JsonResultSchema, OutputSchema, OutputSchemaError, OutputSchemaErrorKind,
    OutputType, ResultShape, ResultValidationError,
};

use crate::expr::{CompiledExpr, Template};
use crate::ids::{NodeId, NodePath, StepId, WorkflowId};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateField {
    pub key: String,
    pub value: Template,
}

pub type WorkflowEnv = Vec<TemplateField>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWorkflow {
    pub id: WorkflowId,
    pub inputs: BTreeMap<String, InputSchema>,
    pub env: WorkflowEnv,
    pub root: ValidatedBlock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedBlock {
    pub nodes: Vec<ValidatedNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedNode {
    pub node_id: NodeId,
    pub user_id: Option<StepId>,
    pub path: NodePath,
    pub attrs: NodeAttrs,
    pub kind: NodeKind,
    pub public_result: ResultSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeAttrs {
    pub if_expr: Option<CompiledExpr>,
    pub env: WorkflowEnv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Action(ActionNode),
    Group(GroupNode),
    Loop(LoopNode),
    Branch(BranchNode),
    Parallel(ParallelNode),
}

impl NodeKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Action(action) => action.action.label(),
            Self::Group(_) => "group",
            Self::Loop(_) => "loop",
            Self::Branch(_) => "branch",
            Self::Parallel(_) => "parallel",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupNode {
    pub body: ValidatedBlock,
    pub exports: Option<ExportSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopNode {
    pub body: ValidatedBlock,
    pub until: CompiledExpr,
    pub max: u32,
    pub exports: Option<ExportSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchNode {
    pub cases: Vec<BranchCase>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParallelNode {
    pub branches: Vec<ParallelBranch>,
    pub exports: Option<ExportSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParallelBranch {
    pub user_id: StepId,
    pub body: ValidatedBlock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchCase {
    pub guard: BranchGuard,
    pub body: ValidatedBlock,
    pub exports: Option<ExportSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchGuard {
    If(CompiledExpr),
    Else,
}

impl BranchGuard {
    pub fn is_else(&self) -> bool {
        matches!(self, Self::Else)
    }

    pub fn if_expr(&self) -> Option<&CompiledExpr> {
        match self {
            Self::If(expr) => Some(expr),
            Self::Else => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultSpec {
    None,
    TypeManaged(ResultContract),
    Shape(ResultShape),
}

impl ResultSpec {
    pub fn result_shape(&self) -> ResultShape {
        match self {
            Self::None => ResultShape::None,
            Self::TypeManaged(contract) => contract.result_shape(),
            Self::Shape(shape) => shape.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportSpec {
    pub fields: Vec<ExportField>,
    pub shape: ResultShape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportField {
    pub key: String,
    pub expr: CompiledExpr,
}

impl ResultContract {
    pub fn result_shape(&self) -> ResultShape {
        match self {
            Self::None => ResultShape::None,
            Self::Text => ResultShape::String,
            Self::Json { schema: Some(schema) } => schema.result_shape(),
            Self::Review { schema } => schema.result_shape(),
            Self::Json { schema: None } => ResultShape::AnyJson,
            Self::WriteFile => {
                ResultShape::Object(BTreeMap::from([("path".to_owned(), ResultShape::String)]))
            }
        }
    }
}
