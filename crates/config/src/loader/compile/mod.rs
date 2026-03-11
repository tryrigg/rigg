mod control;
mod conversation;
mod inputs;
mod scope;

use super::action::compile_action;
use super::expr::compile_wrapped_expr;
pub(super) use super::{ConfigError, ExprRules, FieldSite, RunContext};
use conversation::{
    merge_branch_possible_codex_conversations, possible_codex_conversations_visible_after_node,
    register_possible_codex_conversation, validate_codex_resume_constraints,
    validate_conversation_binding,
};
use inputs::{compile_input_schemas, validate_step_id};
use rigg_core::{
    ExpectedType, ExprRoot, InputSchema, NodeAttrs, NodeId, NodeKind, NodePath, ResultShape,
    ResultSpec, StepId, ValidatedBlock, ValidatedNode, ValidatedWorkflow, WorkflowId,
};
use scope::{compile_env, guaranteed_result_shape};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const BASE_EXPR_ROOTS: &[ExprRoot] = &[ExprRoot::Inputs, ExprRoot::Env, ExprRoot::Steps];
const LOOP_EXPR_ROOTS: &[ExprRoot] =
    &[ExprRoot::Inputs, ExprRoot::Env, ExprRoot::Steps, ExprRoot::Run];

struct CompileState {
    next_node_id: usize,
    seen_step_ids: BTreeSet<StepId>,
    conversation_providers:
        BTreeMap<conversation::ScopedConversationKey, rigg_core::ConversationProvider>,
}

#[derive(Clone, Default)]
struct FlowState {
    possible_codex_conversations: BTreeSet<conversation::ScopedConversationKey>,
}

struct Compiler<'a> {
    path: &'a Path,
    workflow_id: &'a WorkflowId,
    workflow_inputs: &'a BTreeMap<String, InputSchema>,
}

#[derive(Clone, Copy)]
struct BlockScope<'a> {
    visible_steps: &'a BTreeMap<String, ResultShape>,
    parent_path: Option<&'a NodePath>,
    current_loop_path: Option<&'a NodePath>,
}

#[derive(Clone, Copy)]
struct NodeCompileCtx<'a> {
    site: FieldSite<'a>,
    scope: BlockScope<'a>,
    node_path: &'a NodePath,
}

pub(super) fn validate_workflow(
    path: &Path,
    workflow_id: &WorkflowId,
    raw_workflow: crate::syntax::RawWorkflow,
) -> Result<ValidatedWorkflow, ConfigError> {
    let crate::syntax::RawWorkflow { location, inputs, env, steps: raw_steps } = raw_workflow;
    if raw_steps.is_empty() {
        return Err(ConfigError::EmptySteps {
            path: path.to_path_buf(),
            location,
            workflow_id: workflow_id.to_string(),
        });
    }

    let workflow_inputs =
        compile_input_schemas(FieldSite { path, workflow_id, step_index: 0, location }, inputs)?;

    let no_steps = BTreeMap::new();
    let workflow_env = compile_env(
        FieldSite { path, workflow_id, step_index: 0, location },
        env,
        ExprRules {
            allowed_roots: &[ExprRoot::Inputs],
            workflow_inputs: &workflow_inputs,
            known_steps: &no_steps,
            run_context: RunContext::Unavailable,
        },
    )?;

    let mut compiler = Compiler { path, workflow_id, workflow_inputs: &workflow_inputs };
    let mut state = CompileState {
        next_node_id: 0,
        seen_step_ids: BTreeSet::new(),
        conversation_providers: BTreeMap::new(),
    };
    let mut flow = FlowState::default();
    let root = compiler.compile_block(
        &raw_steps,
        &mut state,
        &mut flow,
        BlockScope { visible_steps: &no_steps, parent_path: None, current_loop_path: None },
    )?;

    Ok(ValidatedWorkflow {
        id: workflow_id.clone(),
        inputs: workflow_inputs,
        env: workflow_env,
        root,
    })
}

impl<'a> Compiler<'a> {
    fn compile_block(
        &mut self,
        raw_nodes: &[crate::syntax::RawNode],
        state: &mut CompileState,
        flow: &mut FlowState,
        scope: BlockScope<'_>,
    ) -> Result<ValidatedBlock, ConfigError> {
        let mut visible_steps = scope.visible_steps.clone();
        let mut nodes = Vec::with_capacity(raw_nodes.len());

        for (index, raw_node) in raw_nodes.iter().cloned().enumerate() {
            let block_scope = BlockScope {
                visible_steps: &visible_steps,
                parent_path: scope.parent_path,
                current_loop_path: scope.current_loop_path,
            };
            let node = self.validate_node(index, raw_node, state, flow, block_scope)?;
            if let Some(user_id) = &node.user_id {
                visible_steps.insert(user_id.to_string(), guaranteed_result_shape(&node));
            }
            nodes.push(node);
        }

        Ok(ValidatedBlock { nodes })
    }

    fn validate_node(
        &mut self,
        index: usize,
        raw_node: crate::syntax::RawNode,
        state: &mut CompileState,
        flow: &mut FlowState,
        scope: BlockScope<'_>,
    ) -> Result<ValidatedNode, ConfigError> {
        let step_index = index + 1;
        let site = FieldSite {
            path: self.path,
            workflow_id: self.workflow_id,
            step_index,
            location: raw_node.location,
        };
        let rules =
            Self::expr_rules(self.workflow_inputs, scope.visible_steps, scope.current_loop_path);

        validate_node_shape(site, &raw_node)?;

        let user_id = validate_step_id(
            self.path,
            self.workflow_id,
            step_index,
            raw_node.location,
            raw_node.id.clone(),
            &mut state.seen_step_ids,
        )?;
        let node_id = NodeId::generated(state.next_node_id);
        state.next_node_id += 1;
        let node_path = build_node_path(scope.parent_path, index);

        let attrs = NodeAttrs {
            if_expr: raw_node
                .if_expr
                .as_ref()
                .map(|expr| compile_wrapped_expr(site, "if", expr, Some(ExpectedType::Bool), rules))
                .transpose()?,
            env: compile_env(site, raw_node.env.clone(), rules)?,
        };

        let node_ctx = NodeCompileCtx { site, scope, node_path: &node_path };
        let mut node_flow = flow.clone();
        let (kind, public_result) =
            self.compile_node_kind(&raw_node, state, &mut node_flow, node_ctx, rules, step_index)?;

        let node = ValidatedNode { node_id, user_id, path: node_path, attrs, public_result, kind };

        validate_conversation_binding(site, &node, state, scope.current_loop_path)?;
        validate_codex_resume_constraints(site, &node, flow, scope.current_loop_path)?;
        register_possible_codex_conversation(&node, &mut node_flow, scope.current_loop_path);
        flow.possible_codex_conversations = possible_codex_conversations_visible_after_node(
            &node_flow.possible_codex_conversations,
            &node,
        );
        Ok(node)
    }

    fn compile_node_kind(
        &mut self,
        raw_node: &crate::syntax::RawNode,
        state: &mut CompileState,
        flow: &mut FlowState,
        node_ctx: NodeCompileCtx<'_>,
        rules: ExprRules<'_>,
        step_index: usize,
    ) -> Result<(NodeKind, ResultSpec), ConfigError> {
        match raw_node.node_type.as_str() {
            "codex" | "claude" | "shell" | "write_file" => {
                let action = compile_action(
                    node_ctx.site,
                    &raw_node.node_type,
                    raw_node.with.clone(),
                    rules,
                    node_ctx.scope.current_loop_path.is_some(),
                )?;
                let public_result = ResultSpec::TypeManaged(action.result_contract.clone());
                Ok((NodeKind::Action(action), public_result))
            }
            "group" => {
                let group_node = self.compile_group_node(raw_node, state, flow, node_ctx)?;
                let public_result = control::parallel_public_result(
                    raw_node,
                    group_node.exports.as_ref().map(|exports| exports.shape.clone()),
                );
                Ok((NodeKind::Group(group_node), public_result))
            }
            "loop" => {
                let loop_node = self.compile_loop_node(raw_node, state, flow, node_ctx)?;
                let public_result = loop_node
                    .exports
                    .as_ref()
                    .map(|exports| ResultSpec::Shape(exports.shape.clone()))
                    .unwrap_or(ResultSpec::None);
                Ok((NodeKind::Loop(loop_node), public_result))
            }
            "branch" => {
                let (branch_node, public_result) =
                    self.compile_branch_node(raw_node, state, flow, node_ctx)?;
                Ok((NodeKind::Branch(branch_node), public_result))
            }
            "parallel" => {
                let parallel_node = self.compile_parallel_node(raw_node, state, flow, node_ctx)?;
                let public_result = control::parallel_public_result(
                    raw_node,
                    parallel_node.exports.as_ref().map(|exports| exports.shape.clone()),
                );
                Ok((NodeKind::Parallel(parallel_node), public_result))
            }
            _ => Err(ConfigError::UnsupportedStepType {
                path: self.path.to_path_buf(),
                location: raw_node.location,
                workflow_id: self.workflow_id.to_string(),
                step_index,
                step_type: raw_node.node_type.clone(),
            }),
        }
    }

    fn expr_rules<'b>(
        workflow_inputs: &'b BTreeMap<String, InputSchema>,
        visible_steps: &'b BTreeMap<String, ResultShape>,
        current_loop_path: Option<&NodePath>,
    ) -> ExprRules<'b> {
        ExprRules {
            allowed_roots: allowed_expr_roots(current_loop_path.is_some()),
            workflow_inputs,
            known_steps: visible_steps,
            run_context: run_context(current_loop_path.is_some()),
        }
    }

    fn loop_expr_rules<'b>(
        workflow_inputs: &'b BTreeMap<String, InputSchema>,
        visible_steps: &'b BTreeMap<String, ResultShape>,
    ) -> ExprRules<'b> {
        ExprRules {
            allowed_roots: LOOP_EXPR_ROOTS,
            workflow_inputs,
            known_steps: visible_steps,
            run_context: RunContext::LoopFrame,
        }
    }
}

fn validate_node_shape(
    site: FieldSite<'_>,
    raw_node: &crate::syntax::RawNode,
) -> Result<(), ConfigError> {
    match raw_node.node_type.as_str() {
        "codex" | "claude" | "shell" | "write_file" => {
            let mut invalid_fields = Vec::new();
            if !raw_node.steps.is_empty() {
                invalid_fields.push("steps");
            }
            if !raw_node.cases.is_empty() {
                invalid_fields.push("cases");
            }
            if !raw_node.exports.is_empty() {
                invalid_fields.push("exports");
            }
            if raw_node.until.is_some() {
                invalid_fields.push("until");
            }
            if raw_node.max.is_some() {
                invalid_fields.push("max");
            }
            if !raw_node.branches.is_empty() {
                invalid_fields.push("branches");
            }

            if invalid_fields.is_empty() {
                Ok(())
            } else {
                Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: format!(
                        "`{}` does not accept control-node fields: {}",
                        raw_node.node_type,
                        invalid_fields
                            .into_iter()
                            .map(|field| format!("`{field}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
        }
        "group" => {
            let mut invalid_fields = Vec::new();
            if raw_node.with.is_some() {
                invalid_fields.push("with");
            }
            if !raw_node.cases.is_empty() {
                invalid_fields.push("cases");
            }
            if !raw_node.branches.is_empty() {
                invalid_fields.push("branches");
            }
            if raw_node.until.is_some() {
                invalid_fields.push("until");
            }
            if raw_node.max.is_some() {
                invalid_fields.push("max");
            }
            if raw_node.steps.is_empty() {
                invalid_fields.push("steps");
            }

            if invalid_fields.is_empty() {
                Ok(())
            } else {
                Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: format!(
                        "`group` requires `steps` and does not accept: {}",
                        invalid_fields
                            .into_iter()
                            .map(|field| format!("`{field}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
        }
        "loop" => {
            let mut invalid_fields = Vec::new();
            if raw_node.with.is_some() {
                invalid_fields.push("with");
            }
            if !raw_node.cases.is_empty() {
                invalid_fields.push("cases");
            }
            if !raw_node.branches.is_empty() {
                invalid_fields.push("branches");
            }
            if raw_node.steps.is_empty() {
                invalid_fields.push("steps");
            }
            if raw_node.until.is_none() {
                invalid_fields.push("until");
            }
            if raw_node.max.is_none() {
                invalid_fields.push("max");
            }
            if matches!(raw_node.max, Some(0)) {
                return Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: "`loop.max` must be greater than zero".to_owned(),
                });
            }

            if invalid_fields.is_empty() {
                Ok(())
            } else {
                Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: format!(
                        "`loop` requires `steps`, `until`, and `max`, and does not accept: {}",
                        invalid_fields
                            .into_iter()
                            .map(|field| format!("`{field}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
        }
        "branch" => {
            let mut invalid_fields = Vec::new();
            if raw_node.with.is_some() {
                invalid_fields.push("with");
            }
            if !raw_node.steps.is_empty() {
                invalid_fields.push("steps");
            }
            if !raw_node.branches.is_empty() {
                invalid_fields.push("branches");
            }
            if !raw_node.exports.is_empty() {
                invalid_fields.push("exports");
            }
            if raw_node.until.is_some() {
                invalid_fields.push("until");
            }
            if raw_node.max.is_some() {
                invalid_fields.push("max");
            }
            if raw_node.cases.is_empty() {
                invalid_fields.push("cases");
            }

            if invalid_fields.is_empty() {
                Ok(())
            } else {
                Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: format!(
                        "`branch` requires `cases` and does not accept: {}",
                        invalid_fields
                            .into_iter()
                            .map(|field| format!("`{field}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
        }
        "parallel" => {
            let mut invalid_fields = Vec::new();
            if raw_node.with.is_some() {
                invalid_fields.push("with");
            }
            if !raw_node.steps.is_empty() {
                invalid_fields.push("steps");
            }
            if !raw_node.cases.is_empty() {
                invalid_fields.push("cases");
            }
            if raw_node.until.is_some() {
                invalid_fields.push("until");
            }
            if raw_node.max.is_some() {
                invalid_fields.push("max");
            }
            if raw_node.branches.is_empty() {
                invalid_fields.push("branches");
            }

            if invalid_fields.is_empty() {
                Ok(())
            } else {
                Err(ConfigError::InvalidWith {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    step_index: site.step_index,
                    step_type: raw_node.node_type.clone(),
                    message: format!(
                        "`parallel` requires `branches` and does not accept: {}",
                        invalid_fields
                            .into_iter()
                            .map(|field| format!("`{field}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
        }
        _ => Ok(()),
    }
}

fn build_node_path(parent_path: Option<&NodePath>, index: usize) -> NodePath {
    match parent_path {
        Some(parent_path) => parent_path.child(index),
        None => NodePath::root_child(index),
    }
}

fn allowed_expr_roots(in_loop_frame: bool) -> &'static [ExprRoot] {
    if in_loop_frame { LOOP_EXPR_ROOTS } else { BASE_EXPR_ROOTS }
}

fn run_context(in_loop_frame: bool) -> RunContext {
    if in_loop_frame { RunContext::LoopFrame } else { RunContext::Unavailable }
}
