use super::scope::{
    compile_exports, compile_exports_for_case, guaranteed_scope_after_block, merge_result_shapes,
};
use super::{BlockScope, Compiler, ConfigError, ExprRules, FieldSite, FlowState, NodeCompileCtx};
use crate::loader::compile::conversation::collect_block_conversation_bindings;
use crate::loader::compile::inputs::parse_step_id;
use crate::loader::expr::compile_wrapped_expr;
use crate::syntax::{RawCase, RawNode, RawParallelBranch};
use rigg_core::{
    BranchCase, BranchGuard, BranchNode, ExpectedType, GroupNode, LoopNode, ParallelBranch,
    ParallelNode, ResultShape, ResultSpec, StepId,
};
use std::collections::{BTreeMap, BTreeSet};

impl<'a> Compiler<'a> {
    pub(super) fn compile_group_node(
        &mut self,
        raw_node: &RawNode,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        node_ctx: NodeCompileCtx<'_>,
    ) -> Result<GroupNode, ConfigError> {
        let body = self.compile_block(
            &raw_node.steps,
            state,
            flow,
            BlockScope {
                visible_steps: node_ctx.scope.visible_steps,
                parent_path: Some(node_ctx.node_path),
                current_loop_path: node_ctx.scope.current_loop_path,
            },
        )?;
        let body_scope = guaranteed_scope_after_block(node_ctx.scope.visible_steps, &body);
        let body_rules =
            Self::expr_rules(self.workflow_inputs, &body_scope, node_ctx.scope.current_loop_path);
        let exports = compile_exports(node_ctx.site, raw_node.exports.clone(), body_rules)?;

        Ok(GroupNode { body, exports })
    }

    pub(super) fn compile_loop_node(
        &mut self,
        raw_node: &RawNode,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        node_ctx: NodeCompileCtx<'_>,
    ) -> Result<LoopNode, ConfigError> {
        let site = node_ctx.site;
        let until_source = raw_node.until.as_deref().ok_or_else(|| ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "`loop` requires `until`".to_owned(),
        })?;
        let max = raw_node.max.ok_or_else(|| ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "`loop` requires `max`".to_owned(),
        })?;

        let body = self.compile_block(
            &raw_node.steps,
            state,
            flow,
            BlockScope {
                visible_steps: node_ctx.scope.visible_steps,
                parent_path: Some(node_ctx.node_path),
                current_loop_path: Some(node_ctx.node_path),
            },
        )?;
        let body_scope = guaranteed_scope_after_block(node_ctx.scope.visible_steps, &body);
        let body_rules = Self::loop_expr_rules(self.workflow_inputs, &body_scope);
        let until = compile_wrapped_expr(
            site,
            "until",
            until_source,
            Some(ExpectedType::Bool),
            body_rules,
        )?;
        let exports = compile_exports(site, raw_node.exports.clone(), body_rules)?;

        Ok(LoopNode { body, until, max, exports })
    }

    pub(super) fn compile_parallel_node(
        &mut self,
        raw_node: &RawNode,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        node_ctx: NodeCompileCtx<'_>,
    ) -> Result<ParallelNode, ConfigError> {
        let incoming_flow = flow.clone();
        let mut branch_scopes = Vec::with_capacity(raw_node.branches.len());
        let mut possible_sets = Vec::with_capacity(raw_node.branches.len());
        let mut branches = Vec::with_capacity(raw_node.branches.len());
        let mut seen_branch_ids = BTreeSet::new();
        let mut seen_branch_conversations = BTreeSet::new();

        for (branch_index, raw_branch) in raw_node.branches.iter().cloned().enumerate() {
            let mut branch_flow = incoming_flow.clone();
            let branch = self.compile_parallel_branch(
                state,
                &mut branch_flow,
                node_ctx,
                branch_index,
                &mut seen_branch_ids,
                raw_branch,
            )?;
            let branch_conversations =
                collect_block_conversation_bindings(&branch.body, node_ctx.scope.current_loop_path);
            validate_parallel_branch_conversations(
                node_ctx.site,
                branch_index,
                &branch,
                &branch_conversations,
                &mut seen_branch_conversations,
            )?;
            possible_sets.push(branch_flow.possible_codex_conversations);
            branch_scopes
                .push(guaranteed_scope_after_block(node_ctx.scope.visible_steps, &branch.body));
            branches.push(branch);
        }

        let export_scope =
            merge_parallel_branch_scopes(node_ctx.scope.visible_steps, &branch_scopes);
        let export_rules =
            Self::expr_rules(self.workflow_inputs, &export_scope, node_ctx.scope.current_loop_path);
        let exports = compile_exports(node_ctx.site, raw_node.exports.clone(), export_rules)?;
        flow.possible_codex_conversations =
            super::merge_branch_possible_codex_conversations(&incoming_flow, possible_sets);

        Ok(ParallelNode { branches, exports })
    }

    pub(super) fn compile_branch_node(
        &mut self,
        raw_node: &RawNode,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        node_ctx: NodeCompileCtx<'_>,
    ) -> Result<(BranchNode, ResultSpec), ConfigError> {
        let mut cases = Vec::with_capacity(raw_node.cases.len());
        let mut possible_sets = Vec::with_capacity(raw_node.cases.len());
        let incoming_flow = flow.clone();

        for (case_index, raw_case) in raw_node.cases.iter().cloned().enumerate() {
            validate_branch_case_shape(node_ctx.site, raw_node, &raw_case, case_index)?;
            let mut case_flow = incoming_flow.clone();
            let case =
                self.compile_branch_case(state, &mut case_flow, node_ctx, case_index, raw_case)?;
            possible_sets.push(case_flow.possible_codex_conversations);
            cases.push(case);
        }

        let has_else = cases.iter().any(|case| case.guard.is_else());
        let export_shape = common_branch_export_shape(node_ctx.site, raw_node, &cases, has_else)?;
        let public_result = branch_public_result(raw_node, has_else, export_shape);
        flow.possible_codex_conversations =
            super::merge_branch_possible_codex_conversations(&incoming_flow, possible_sets);

        Ok((BranchNode { cases }, public_result))
    }

    fn compile_branch_case(
        &mut self,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        branch_ctx: NodeCompileCtx<'_>,
        case_index: usize,
        raw_case: RawCase,
    ) -> Result<BranchCase, ConfigError> {
        let case_site = FieldSite { location: raw_case.location, ..branch_ctx.site };
        let outer_rules = Self::expr_rules(
            self.workflow_inputs,
            branch_ctx.scope.visible_steps,
            branch_ctx.scope.current_loop_path,
        );
        let guard = compile_branch_guard(case_site, case_index, &raw_case, outer_rules)?;

        let case_path = branch_ctx.node_path.child(case_index);
        let body = self.compile_block(
            &raw_case.steps,
            state,
            flow,
            BlockScope {
                visible_steps: branch_ctx.scope.visible_steps,
                parent_path: Some(&case_path),
                current_loop_path: branch_ctx.scope.current_loop_path,
            },
        )?;
        let body_scope = guaranteed_scope_after_block(branch_ctx.scope.visible_steps, &body);
        let body_rules =
            Self::expr_rules(self.workflow_inputs, &body_scope, branch_ctx.scope.current_loop_path);
        let exports =
            compile_exports_for_case(case_site, case_index, raw_case.exports, body_rules)?;

        Ok(BranchCase { guard, body, exports })
    }

    fn compile_parallel_branch(
        &mut self,
        state: &mut super::CompileState,
        flow: &mut FlowState,
        parallel_ctx: NodeCompileCtx<'_>,
        branch_index: usize,
        seen_branch_ids: &mut BTreeSet<StepId>,
        raw_branch: RawParallelBranch,
    ) -> Result<ParallelBranch, ConfigError> {
        validate_parallel_branch_shape(parallel_ctx.site, &raw_branch, branch_index)?;
        let Some(user_id) = parse_step_id(
            self.path,
            self.workflow_id,
            parallel_ctx.site.step_index,
            raw_branch.location,
            raw_branch.id.clone(),
        )?
        else {
            return Err(ConfigError::InvalidWith {
                path: self.path.to_path_buf(),
                location: raw_branch.location,
                workflow_id: self.workflow_id.to_string(),
                step_index: parallel_ctx.site.step_index,
                step_type: "parallel".to_owned(),
                message: format!("`branches[{branch_index}]` must define `id`"),
            });
        };
        if !seen_branch_ids.insert(user_id.clone()) {
            return Err(ConfigError::InvalidWith {
                path: self.path.to_path_buf(),
                location: raw_branch.location,
                workflow_id: self.workflow_id.to_string(),
                step_index: parallel_ctx.site.step_index,
                step_type: "parallel".to_owned(),
                message: format!(
                    "`branches[{branch_index}]` reuses local branch id `{user_id}` within the same parallel node"
                ),
            });
        }
        let branch_path = parallel_ctx.node_path.child(branch_index);
        let body = self.compile_block(
            &raw_branch.steps,
            state,
            flow,
            BlockScope {
                visible_steps: parallel_ctx.scope.visible_steps,
                parent_path: Some(&branch_path),
                current_loop_path: parallel_ctx.scope.current_loop_path,
            },
        )?;
        Ok(ParallelBranch { user_id, body })
    }
}

fn validate_parallel_branch_shape(
    site: FieldSite<'_>,
    raw_branch: &RawParallelBranch,
    branch_index: usize,
) -> Result<(), ConfigError> {
    if raw_branch.id.is_none() {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_branch.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: "parallel".to_owned(),
            message: format!("`branches[{branch_index}]` must define `id`"),
        });
    }
    if raw_branch.steps.is_empty() {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_branch.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: "parallel".to_owned(),
            message: format!("`branches[{branch_index}]` must define `steps`"),
        });
    }

    Ok(())
}

fn merge_parallel_branch_scopes(
    inherited_scope: &BTreeMap<String, ResultShape>,
    branch_scopes: &[BTreeMap<String, ResultShape>],
) -> BTreeMap<String, ResultShape> {
    let mut merged = inherited_scope.clone();
    for branch_scope in branch_scopes {
        for (step_id, shape) in branch_scope {
            merged.insert(step_id.clone(), shape.clone());
        }
    }
    merged
}

fn validate_parallel_branch_conversations(
    site: FieldSite<'_>,
    branch_index: usize,
    branch: &ParallelBranch,
    branch_conversations: &BTreeSet<super::conversation::ScopedConversationKey>,
    seen_conversations: &mut BTreeSet<super::conversation::ScopedConversationKey>,
) -> Result<(), ConfigError> {
    for conversation in branch_conversations {
        if seen_conversations.contains(conversation) {
            return Err(ConfigError::InvalidWith {
                path: site.path.to_path_buf(),
                location: site.location,
                workflow_id: site.workflow_id.to_string(),
                step_index: site.step_index,
                step_type: "parallel".to_owned(),
                message: format!(
                    "`branches[{branch_index}]` (`{}`) cannot reuse `conversation: {}`; sibling parallel branches execute concurrently and cannot share a conversation binding",
                    branch.user_id,
                    conversation.name()
                ),
            });
        }
    }
    seen_conversations.extend(branch_conversations.iter().cloned());
    Ok(())
}

fn compile_branch_guard(
    site: FieldSite<'_>,
    case_index: usize,
    raw_case: &RawCase,
    rules: ExprRules<'_>,
) -> Result<BranchGuard, ConfigError> {
    if raw_case.is_else {
        return Ok(BranchGuard::Else);
    }

    let if_expr = raw_case.if_expr.as_deref().ok_or_else(|| ConfigError::InvalidWith {
        path: site.path.to_path_buf(),
        location: raw_case.location,
        workflow_id: site.workflow_id.to_string(),
        step_index: site.step_index,
        step_type: "branch".to_owned(),
        message: format!("`cases[{case_index}]` must define `if` unless it is an `else` case"),
    })?;

    let expr = compile_wrapped_expr(
        site,
        &format!("cases[{case_index}].if"),
        if_expr,
        Some(ExpectedType::Bool),
        rules,
    )?;
    Ok(BranchGuard::If(expr))
}

fn validate_branch_case_shape(
    site: FieldSite<'_>,
    raw_node: &RawNode,
    raw_case: &RawCase,
    case_index: usize,
) -> Result<(), ConfigError> {
    if raw_case.is_else && raw_case.if_expr.is_some() {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_case.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: format!("`cases[{case_index}]` cannot set both `else` and `if`"),
        });
    }
    if !raw_case.is_else && raw_case.if_expr.is_none() {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_case.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: format!("`cases[{case_index}]` must define `if` unless it is an `else` case"),
        });
    }
    if raw_case.is_else && case_index + 1 != raw_node.cases.len() {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_case.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "`else` case must be the last branch case".to_owned(),
        });
    }
    if raw_node.cases.iter().filter(|case| case.is_else).count() > 1 {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: raw_case.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "`branch` may define at most one `else` case".to_owned(),
        });
    }

    Ok(())
}

fn common_branch_export_shape(
    site: FieldSite<'_>,
    raw_node: &RawNode,
    cases: &[BranchCase],
    has_else: bool,
) -> Result<Option<ResultShape>, ConfigError> {
    let Some(common_shape) = cases
        .iter()
        .filter_map(|case| case.exports.as_ref().map(|exports| &exports.shape))
        .cloned()
        .reduce(|left, right| merge_result_shapes(&left, &right).unwrap_or(ResultShape::None))
    else {
        return Ok(None);
    };

    if !has_else {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "`branch` without `else` cannot declare case `exports`".to_owned(),
        });
    }
    if cases.iter().any(|case| case.exports.is_none()) {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "all `branch` cases must declare `exports` when any case exports a result"
                .to_owned(),
        });
    }
    if common_shape == ResultShape::None {
        return Err(ConfigError::InvalidWith {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: raw_node.node_type.clone(),
            message: "all `branch` case exports must declare the same result shape".to_owned(),
        });
    }

    Ok(Some(common_shape))
}

pub(super) fn branch_public_result(
    raw_node: &RawNode,
    has_else: bool,
    export_shape: Option<ResultShape>,
) -> ResultSpec {
    if raw_node.if_expr.is_some() || !has_else {
        return ResultSpec::None;
    }

    export_shape.map(ResultSpec::Shape).unwrap_or(ResultSpec::None)
}

pub(super) fn parallel_public_result(
    raw_node: &RawNode,
    export_shape: Option<ResultShape>,
) -> ResultSpec {
    if raw_node.if_expr.is_some() {
        return ResultSpec::None;
    }

    export_shape.map(ResultSpec::Shape).unwrap_or(ResultSpec::None)
}
