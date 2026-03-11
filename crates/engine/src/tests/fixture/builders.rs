use crate::progress::ProviderEvent;
use crate::{
    ActionKind, ActionNode, BranchCase, BranchGuard, BranchNode, CapturedValue, ClaudeStep,
    CodexAction, CodexExec, CodexMode, CodexStep, ConversationBinding, ConversationHandle,
    ConversationScope, ExportField, ExportSpec, GroupNode, InputSchema, JsonResultSchema, LoopNode,
    NodeAttrs, NodeId, NodeKind, NodePath, ParallelBranch, ParallelNode, PermissionMode,
    ResultContract, ResultShape, ResultSpec, RunId, RunState, RunStatus, ShellOutput, ShellStep,
    StepId, StepRunRequest, StepRunResult, Template, ValidatedBlock, ValidatedNode,
    ValidatedWorkflow, WorkflowId,
};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::str::FromStr;

pub(crate) fn plan_with_nodes(
    nodes: Vec<ValidatedNode>,
) -> Result<crate::EnginePlan, Box<dyn std::error::Error>> {
    Ok(crate::EnginePlan {
        project_root: std::env::temp_dir(),
        config_files: vec![],
        config_hash: String::new(),
        workflow: ValidatedWorkflow {
            id: WorkflowId::from_str("workflow")?,
            inputs: BTreeMap::from([(
                "requirements".to_owned(),
                input_schema(serde_json::json!({ "type": "string" }))?,
            )]),
            env: vec![],
            root: ValidatedBlock { nodes },
        },
        invocation_inputs: serde_json::json!({"requirements":"x"}),
        parent_env: BTreeMap::new(),
        tool_version: String::new(),
    })
}

pub(crate) fn empty_state(plan: &crate::EnginePlan) -> RunState {
    crate::run_state::build_initial_state(
        &plan.workflow,
        RunId::new(),
        "2026-01-01T00:00:00Z".to_owned(),
    )
}

pub(crate) fn empty_run_state(run_id: &str) -> Result<RunState, Box<dyn std::error::Error>> {
    Ok(RunState {
        run_id: RunId::try_from(run_id)?,
        workflow_id: WorkflowId::try_from("test")?,
        status: RunStatus::Running,
        reason: None,
        started_at: "2026-01-01T00:00:00Z".to_owned(),
        finished_at: None,
        workflow_conversations: BTreeMap::new(),
        nodes: BTreeMap::new(),
        node_frames: BTreeMap::new(),
    })
}

pub(crate) fn shell_node(
    index: usize,
    user_id: &str,
    command: &str,
    result_mode: ShellOutput,
    result_contract: ResultContract,
    if_expr: Option<&str>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    action_node(
        index,
        Some(user_id),
        ActionKind::Shell(ShellStep { command: Template::parse(command)?, result_mode }),
        result_contract,
        if_expr,
    )
}

pub(crate) fn text_shell_node(
    index: usize,
    user_id: &str,
    command: &str,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    shell_node(index, user_id, command, ShellOutput::Text, ResultContract::Text, None)
}

pub(crate) fn shell_node_at_path(
    index: usize,
    user_id: &str,
    path: NodePath,
    command: &str,
    result_mode: ShellOutput,
    result_contract: ResultContract,
    if_expr: Option<&str>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    action_node_at_path(
        index,
        Some(user_id),
        path,
        ActionKind::Shell(ShellStep { command: Template::parse(command)?, result_mode }),
        result_contract,
        if_expr,
    )
}

pub(crate) fn text_shell_node_at_path(
    index: usize,
    user_id: &str,
    path: NodePath,
    command: &str,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    shell_node_at_path(index, user_id, path, command, ShellOutput::Text, ResultContract::Text, None)
}

pub(crate) fn claude_node(
    index: usize,
    user_id: &str,
    prompt: &str,
    output_schema: Option<JsonValue>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    action_node(
        index,
        Some(user_id),
        ActionKind::Claude(ClaudeStep {
            prompt: Template::parse(prompt)?,
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: crate::Persistence::Persist,
            conversation: None,
        }),
        output_schema
            .map(|schema| {
                structured_schema(schema)
                    .map(|schema| ResultContract::Json { schema: Some(schema) })
            })
            .transpose()?
            .unwrap_or(ResultContract::Text),
        None,
    )
}

pub(crate) fn structured_schema(
    schema: JsonValue,
) -> Result<JsonResultSchema, Box<dyn std::error::Error>> {
    Ok(JsonResultSchema::parse_at(&schema, "test.schema")?)
}

pub(crate) fn input_schema(schema: JsonValue) -> Result<InputSchema, Box<dyn std::error::Error>> {
    Ok(InputSchema::parse_at(&schema, "test.input")?)
}

pub(crate) fn codex_exec_node(
    index: usize,
    user_id: &str,
    prompt: &str,
    conversation: Option<&str>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    action_node(
        index,
        Some(user_id),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse(prompt)?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: conversation.map(workflow_conversation).transpose()?,
            }),
        }),
        ResultContract::Text,
        None,
    )
}

pub(crate) fn action_node(
    index: usize,
    user_id: Option<&str>,
    action: ActionKind,
    result_contract: ResultContract,
    if_expr: Option<&str>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    action_node_at_path(
        index,
        user_id,
        NodePath::root_child(index),
        action,
        result_contract,
        if_expr,
    )
}

pub(crate) fn action_node_at_path(
    index: usize,
    user_id: Option<&str>,
    path: NodePath,
    action: ActionKind,
    result_contract: ResultContract,
    if_expr: Option<&str>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    Ok(ValidatedNode {
        node_id: NodeId::generated(index),
        user_id: user_id.map(str::parse).transpose()?,
        path,
        attrs: NodeAttrs {
            if_expr: if_expr
                .map(|expr| {
                    crate::CompiledExpr::compile(
                        expr.trim_start_matches("${{ ").trim_end_matches(" }}"),
                        Some(crate::ExpectedType::Bool),
                    )
                })
                .transpose()?,
            env: vec![],
        },
        kind: NodeKind::Action(ActionNode { action, result_contract: result_contract.clone() }),
        public_result: ResultSpec::TypeManaged(result_contract),
    })
}

pub(crate) fn workflow_conversation(
    name: &str,
) -> Result<ConversationBinding, Box<dyn std::error::Error>> {
    conversation(name, ConversationScope::Workflow)
}

pub(crate) fn conversation(
    name: &str,
    scope: ConversationScope,
) -> Result<ConversationBinding, Box<dyn std::error::Error>> {
    Ok(ConversationBinding { name: name.parse()?, scope })
}

pub(crate) fn handle_result(stdout: &str, thread_id: &str) -> StepRunResult {
    step_result(
        0,
        "",
        "",
        Some(CapturedValue::Text(stdout.to_owned())),
        Some(ConversationHandle::Codex { thread_id: thread_id.to_owned() }),
        Vec::new(),
    )
}

pub(crate) fn step_result(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    result: Option<CapturedValue>,
    conversation_handle: Option<ConversationHandle>,
    provider_events: Vec<ProviderEvent>,
) -> StepRunResult {
    StepRunResult {
        started_at: "2026-01-01T00:00:00Z".to_owned(),
        finished_at: "2026-01-01T00:00:01Z".to_owned(),
        duration_ms: 1,
        exit_code,
        stdout: stdout.to_owned(),
        stderr: stderr.to_owned(),
        result,
        conversation_handle,
        provider_events,
    }
}

pub(crate) fn text_step_with_provider_events(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    provider_events: Vec<ProviderEvent>,
) -> StepRunResult {
    step_result(
        exit_code,
        stdout,
        stderr,
        (exit_code == 0).then(|| CapturedValue::Text(stdout.to_owned())),
        None,
        provider_events,
    )
}

pub(crate) fn successful_text_step(stdout: &str) -> StepRunResult {
    text_step_with_provider_events(0, stdout, "", Vec::new())
}

pub(crate) fn successful_json_step(value: JsonValue) -> StepRunResult {
    step_result(0, "", "", Some(CapturedValue::Json(value)), None, Vec::new())
}

pub(crate) fn failed_step(stderr: &str) -> StepRunResult {
    step_result(1, "", stderr, None, None, Vec::new())
}

pub(crate) fn assert_resume_thread(request: &StepRunRequest, expected: Option<&str>) {
    match request {
        StepRunRequest::Codex(request) => {
            let actual = request
                .conversation
                .as_ref()
                .and_then(|conversation| conversation.resume_thread_id.as_deref());
            assert_eq!(actual, expected);
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

pub(crate) fn request_key(request: &StepRunRequest) -> String {
    match request {
        StepRunRequest::Shell(request) => format!("shell:{}", request.command),
        StepRunRequest::Claude(request) => format!("claude:{}", request.prompt),
        StepRunRequest::Codex(request) => match &request.action {
            crate::RenderedCodexAction::Exec { prompt, .. } => format!("codex_exec:{prompt}"),
            crate::RenderedCodexAction::Review { prompt, .. } => {
                format!("codex_review:{}", prompt.as_deref().unwrap_or_default())
            }
        },
        StepRunRequest::WriteFile(request) => format!("write_file:{}", request.path.display()),
    }
}

pub(crate) fn loop_node(
    index: usize,
    user_id: &str,
    body_nodes: Vec<ValidatedNode>,
    until_expr: &str,
    max: u32,
    exports: Vec<(&str, &str, ResultShape)>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    loop_node_at_path(
        index,
        user_id,
        NodePath::root_child(index),
        body_nodes,
        until_expr,
        max,
        exports,
    )
}

pub(crate) fn loop_node_at_path(
    index: usize,
    user_id: &str,
    path: NodePath,
    body_nodes: Vec<ValidatedNode>,
    until_expr: &str,
    max: u32,
    exports: Vec<(&str, &str, ResultShape)>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    let exports = if exports.is_empty() {
        None
    } else {
        Some(ExportSpec {
            fields: exports
                .iter()
                .map(|(key, expr, _)| {
                    Ok(ExportField {
                        key: (*key).to_owned(),
                        expr: crate::CompiledExpr::compile((*expr).to_owned(), None)?,
                    })
                })
                .collect::<Result<Vec<_>, crate::ExprError>>()?,
            shape: ResultShape::Object(
                exports.iter().map(|(key, _, shape)| ((*key).to_owned(), shape.clone())).collect(),
            ),
        })
    };
    let public_result = exports
        .as_ref()
        .map(|exports| ResultSpec::Shape(exports.shape.clone()))
        .unwrap_or(ResultSpec::None);

    Ok(ValidatedNode {
        node_id: NodeId::generated(index),
        user_id: Some(user_id.parse()?),
        path,
        attrs: NodeAttrs { if_expr: None, env: vec![] },
        kind: NodeKind::Loop(LoopNode {
            body: ValidatedBlock { nodes: body_nodes },
            until: crate::CompiledExpr::compile(
                until_expr.to_owned(),
                Some(crate::ExpectedType::Bool),
            )?,
            max,
            exports,
        }),
        public_result,
    })
}

pub(crate) fn group_node(
    index: usize,
    user_id: &str,
    body_nodes: Vec<ValidatedNode>,
    exports: Vec<(&str, &str, ResultShape)>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    let path = NodePath::root_child(index);
    let body_nodes = rebase_nodes(body_nodes, &path)?;
    let exports = if exports.is_empty() {
        None
    } else {
        Some(ExportSpec {
            fields: exports
                .iter()
                .map(|(key, expr, _)| {
                    Ok(ExportField {
                        key: (*key).to_owned(),
                        expr: crate::CompiledExpr::compile((*expr).to_owned(), None)?,
                    })
                })
                .collect::<Result<Vec<_>, crate::ExprError>>()?,
            shape: ResultShape::Object(
                exports.iter().map(|(key, _, shape)| ((*key).to_owned(), shape.clone())).collect(),
            ),
        })
    };
    let public_result = exports
        .as_ref()
        .map(|exports| ResultSpec::Shape(exports.shape.clone()))
        .unwrap_or(ResultSpec::None);

    Ok(ValidatedNode {
        node_id: NodeId::generated(index),
        user_id: Some(user_id.parse()?),
        path,
        attrs: NodeAttrs { if_expr: None, env: vec![] },
        kind: NodeKind::Group(GroupNode { body: ValidatedBlock { nodes: body_nodes }, exports }),
        public_result,
    })
}

pub(crate) fn branch_node(
    index: usize,
    user_id: &str,
    cases: Vec<BranchCaseFixture<'_>>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    let path = NodePath::root_child(index);
    let mut branch_cases = Vec::with_capacity(cases.len());

    for (case_index, case) in cases.into_iter().enumerate() {
        let body_path = path.child(case_index);
        let exports = case.exports();
        let export_spec = if exports.is_empty() {
            None
        } else {
            Some(ExportSpec {
                fields: exports
                    .iter()
                    .map(|(key, expr, _)| {
                        Ok(ExportField {
                            key: (*key).to_owned(),
                            expr: crate::CompiledExpr::compile((*expr).to_owned(), None)?,
                        })
                    })
                    .collect::<Result<Vec<_>, crate::ExprError>>()?,
                shape: ResultShape::Object(
                    exports
                        .iter()
                        .map(|(key, _, shape)| ((*key).to_owned(), shape.clone()))
                        .collect(),
                ),
            })
        };
        branch_cases.push(BranchCase {
            guard: compile_branch_guard_fixture(case.guard())?,
            body: ValidatedBlock { nodes: rebase_nodes(case.into_body_nodes(), &body_path)? },
            exports: export_spec,
        });
    }

    let public_result = branch_cases
        .first()
        .and_then(|case| case.exports.as_ref())
        .map(|exports| ResultSpec::Shape(exports.shape.clone()))
        .unwrap_or(ResultSpec::None);

    Ok(ValidatedNode {
        node_id: NodeId::generated(index),
        user_id: Some(user_id.parse()?),
        path,
        attrs: NodeAttrs { if_expr: None, env: vec![] },
        kind: NodeKind::Branch(BranchNode { cases: branch_cases }),
        public_result,
    })
}

pub(crate) fn parallel_node(
    index: usize,
    user_id: &str,
    branches: Vec<Vec<ValidatedNode>>,
    exports: Vec<(&str, &str, ResultShape)>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    parallel_node_at_path(index, user_id, NodePath::root_child(index), branches, exports)
}

pub(crate) fn parallel_node_at_path(
    index: usize,
    user_id: &str,
    path: NodePath,
    branches: Vec<Vec<ValidatedNode>>,
    exports: Vec<(&str, &str, ResultShape)>,
) -> Result<ValidatedNode, Box<dyn std::error::Error>> {
    let branches = branches
        .into_iter()
        .enumerate()
        .map(|(branch_index, body_nodes)| {
            let branch_path = path.child(branch_index);
            let branch_user_id: StepId = format!("{user_id}_branch_{branch_index}").parse()?;
            Ok(ParallelBranch {
                user_id: branch_user_id,
                body: ValidatedBlock { nodes: rebase_nodes(body_nodes, &branch_path)? },
            })
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let exports = if exports.is_empty() {
        None
    } else {
        Some(ExportSpec {
            fields: exports
                .iter()
                .map(|(key, expr, _)| {
                    Ok(ExportField {
                        key: (*key).to_owned(),
                        expr: crate::CompiledExpr::compile((*expr).to_owned(), None)?,
                    })
                })
                .collect::<Result<Vec<_>, crate::ExprError>>()?,
            shape: ResultShape::Object(
                exports.iter().map(|(key, _, shape)| ((*key).to_owned(), shape.clone())).collect(),
            ),
        })
    };
    let public_result = exports
        .as_ref()
        .map(|exports| ResultSpec::Shape(exports.shape.clone()))
        .unwrap_or(ResultSpec::None);

    Ok(ValidatedNode {
        node_id: NodeId::generated(index),
        user_id: Some(user_id.parse()?),
        path,
        attrs: NodeAttrs { if_expr: None, env: vec![] },
        kind: NodeKind::Parallel(ParallelNode { branches, exports }),
        public_result,
    })
}

pub(crate) enum BranchCaseFixture<'a> {
    If {
        condition: &'a str,
        body_nodes: Vec<ValidatedNode>,
        exports: Vec<(&'a str, &'a str, ResultShape)>,
    },
    Else {
        body_nodes: Vec<ValidatedNode>,
        exports: Vec<(&'a str, &'a str, ResultShape)>,
    },
}

impl<'a> BranchCaseFixture<'a> {
    fn guard(&self) -> BranchCaseGuardFixture<'a> {
        match self {
            Self::If { condition, .. } => BranchCaseGuardFixture::If(condition),
            Self::Else { .. } => BranchCaseGuardFixture::Else,
        }
    }

    fn exports(&self) -> &[(&'a str, &'a str, ResultShape)] {
        match self {
            Self::If { exports, .. } | Self::Else { exports, .. } => exports,
        }
    }

    fn into_body_nodes(self) -> Vec<ValidatedNode> {
        match self {
            Self::If { body_nodes, .. } | Self::Else { body_nodes, .. } => body_nodes,
        }
    }
}

#[derive(Clone, Copy)]
enum BranchCaseGuardFixture<'a> {
    If(&'a str),
    Else,
}

pub(crate) fn branch_if<'a>(
    condition: &'a str,
    body_nodes: Vec<ValidatedNode>,
    exports: Vec<(&'a str, &'a str, ResultShape)>,
) -> BranchCaseFixture<'a> {
    BranchCaseFixture::If { condition, body_nodes, exports }
}

pub(crate) fn branch_else<'a>(
    body_nodes: Vec<ValidatedNode>,
    exports: Vec<(&'a str, &'a str, ResultShape)>,
) -> BranchCaseFixture<'a> {
    BranchCaseFixture::Else { body_nodes, exports }
}

fn compile_branch_guard_fixture(
    guard: BranchCaseGuardFixture<'_>,
) -> Result<BranchGuard, crate::ExprError> {
    match guard {
        BranchCaseGuardFixture::If(condition) => Ok(BranchGuard::If(crate::CompiledExpr::compile(
            condition.to_owned(),
            Some(crate::ExpectedType::Bool),
        )?)),
        BranchCaseGuardFixture::Else => Ok(BranchGuard::Else),
    }
}

fn rebase_nodes(
    mut nodes: Vec<ValidatedNode>,
    parent_path: &NodePath,
) -> Result<Vec<ValidatedNode>, Box<dyn std::error::Error>> {
    for (index, node) in nodes.iter_mut().enumerate() {
        rebase_node(node, &parent_path.child(index))?;
    }
    Ok(nodes)
}

fn rebase_node(
    node: &mut ValidatedNode,
    path: &NodePath,
) -> Result<(), Box<dyn std::error::Error>> {
    node.path = path.clone();
    match &mut node.kind {
        NodeKind::Action(_) => {}
        NodeKind::Group(group_node) => {
            for (index, child) in group_node.body.nodes.iter_mut().enumerate() {
                rebase_node(child, &path.child(index))?;
            }
        }
        NodeKind::Loop(loop_node) => {
            for (index, child) in loop_node.body.nodes.iter_mut().enumerate() {
                rebase_node(child, &path.child(index))?;
            }
        }
        NodeKind::Branch(branch_node) => {
            for (case_index, case) in branch_node.cases.iter_mut().enumerate() {
                let case_path = path.child(case_index);
                for (index, child) in case.body.nodes.iter_mut().enumerate() {
                    rebase_node(child, &case_path.child(index))?;
                }
            }
        }
        NodeKind::Parallel(parallel_node) => {
            for (branch_index, branch) in parallel_node.branches.iter_mut().enumerate() {
                let branch_path = path.child(branch_index);
                for (index, child) in branch.body.nodes.iter_mut().enumerate() {
                    rebase_node(child, &branch_path.child(index))?;
                }
            }
        }
    }
    Ok(())
}
