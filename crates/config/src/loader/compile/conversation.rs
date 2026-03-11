use super::{CompileState, ConfigError, FieldSite, FlowState};
use rigg_core::{
    ActionKind, ClaudeStep, CodexAction, CodexExec, ConversationBinding, ConversationName,
    ConversationProvider, ConversationScope, NodeKind, NodePath, ValidatedBlock, ValidatedNode,
};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct ScopedConversationKey {
    name: ConversationName,
    scope: ScopedConversationOwner,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ScopedConversationOwner {
    Workflow,
    Loop(NodePath),
    Iteration(NodePath),
}

impl ScopedConversationKey {
    pub(super) fn name(&self) -> &ConversationName {
        &self.name
    }
}

pub(super) fn collect_block_conversation_bindings(
    block: &ValidatedBlock,
    current_loop_path: Option<&NodePath>,
) -> BTreeSet<ScopedConversationKey> {
    let mut bindings = BTreeSet::new();
    collect_block_conversation_bindings_inner(block, current_loop_path, &mut bindings);
    bindings
}

fn collect_block_conversation_bindings_inner(
    block: &ValidatedBlock,
    current_loop_path: Option<&NodePath>,
    bindings: &mut BTreeSet<ScopedConversationKey>,
) {
    for node in &block.nodes {
        collect_node_conversation_bindings(node, current_loop_path, bindings);
    }
}

fn collect_node_conversation_bindings(
    node: &ValidatedNode,
    current_loop_path: Option<&NodePath>,
    bindings: &mut BTreeSet<ScopedConversationKey>,
) {
    if let Some((conversation, _)) = node_conversation_binding(node)
        && let Some(scoped_key) = scoped_conversation_key(conversation, current_loop_path)
    {
        bindings.insert(scoped_key);
    }

    match &node.kind {
        NodeKind::Action(_) => {}
        NodeKind::Group(group_node) => {
            collect_block_conversation_bindings_inner(
                &group_node.body,
                current_loop_path,
                bindings,
            );
        }
        NodeKind::Loop(loop_node) => {
            collect_block_conversation_bindings_inner(&loop_node.body, Some(&node.path), bindings);
        }
        NodeKind::Branch(branch_node) => {
            for case in &branch_node.cases {
                collect_block_conversation_bindings_inner(&case.body, current_loop_path, bindings);
            }
        }
        NodeKind::Parallel(parallel_node) => {
            for branch in &parallel_node.branches {
                collect_block_conversation_bindings_inner(
                    &branch.body,
                    current_loop_path,
                    bindings,
                );
            }
        }
    }
}

pub(super) fn validate_conversation_binding(
    site: FieldSite<'_>,
    node: &ValidatedNode,
    state: &mut CompileState,
    current_loop_path: Option<&NodePath>,
) -> Result<(), ConfigError> {
    let Some((conversation, provider)) = node_conversation_binding(node) else {
        return Ok(());
    };
    let scoped_key = scoped_conversation_key_for_node(site, node, conversation, current_loop_path)?;
    match state.conversation_providers.get(&scoped_key) {
        Some(previous_provider) if previous_provider != &provider => Err(invalid_node_with(
            site,
            node.kind.label(),
            format!(
                "`conversation: {}` is already bound to `{previous_provider}` and cannot be reused by `{provider}`",
                conversation.name
            ),
        )),
        Some(_) => Ok(()),
        None => {
            state.conversation_providers.insert(scoped_key, provider);
            Ok(())
        }
    }
}

fn node_conversation_binding(
    node: &ValidatedNode,
) -> Option<(&ConversationBinding, ConversationProvider)> {
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        return None;
    };
    match &action.action {
        ActionKind::Claude(ClaudeStep { conversation, .. }) => {
            conversation.as_ref().map(|conversation| (conversation, ConversationProvider::Claude))
        }
        ActionKind::Codex(step) => match &step.action {
            CodexAction::Exec(CodexExec { conversation, .. }) => conversation
                .as_ref()
                .map(|conversation| (conversation, ConversationProvider::Codex)),
            CodexAction::Review(_) => None,
        },
        ActionKind::Shell(_) | ActionKind::WriteFile(_) => None,
    }
}

pub(super) fn validate_codex_resume_constraints(
    site: FieldSite<'_>,
    node: &ValidatedNode,
    flow: &FlowState,
    current_loop_path: Option<&NodePath>,
) -> Result<(), ConfigError> {
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        return Ok(());
    };
    let ActionKind::Codex(step_kind) = &action.action else {
        return Ok(());
    };
    let CodexAction::Exec(exec) = &step_kind.action else {
        return Ok(());
    };
    let Some(conversation) = exec.conversation.as_ref() else {
        return Ok(());
    };
    let scoped_key = scoped_conversation_key_for_node(site, node, conversation, current_loop_path)?;

    if !flow.possible_codex_conversations.contains(&scoped_key) {
        return Ok(());
    }

    if !exec.add_dirs.is_empty() {
        return Err(invalid_node_with(
            site,
            node.kind.label(),
            format!(
                "`conversation: {}` may resume a previous Codex session, but `codex exec resume` does not support `with.add_dirs`",
                conversation.name
            ),
        ));
    }
    if action.result_contract.result_schema().is_some() {
        return Err(invalid_node_with(
            site,
            node.kind.label(),
            format!(
                "`conversation: {}` may resume a previous Codex session, but `codex exec resume` does not support `with.output_schema`",
                conversation.name
            ),
        ));
    }
    Ok(())
}

pub(super) fn register_possible_codex_conversation(
    node: &ValidatedNode,
    flow: &mut FlowState,
    current_loop_path: Option<&NodePath>,
) {
    match &node.kind {
        rigg_core::NodeKind::Action(action) => {
            let ActionKind::Codex(step_kind) = &action.action else {
                return;
            };
            let CodexAction::Exec(exec) = &step_kind.action else {
                return;
            };
            let Some(conversation) = exec.conversation.as_ref() else {
                return;
            };
            let Some(scoped_key) = scoped_conversation_key(conversation, current_loop_path) else {
                debug_assert!(
                    false,
                    "conversation scope {:?} requires an enclosing loop",
                    conversation.scope
                );
                return;
            };
            flow.possible_codex_conversations.insert(scoped_key);
        }
        rigg_core::NodeKind::Group(_)
        | rigg_core::NodeKind::Loop(_)
        | rigg_core::NodeKind::Branch(_)
        | rigg_core::NodeKind::Parallel(_) => {}
    }
}

pub(super) fn merge_branch_possible_codex_conversations(
    incoming_flow: &FlowState,
    case_possibles: Vec<BTreeSet<ScopedConversationKey>>,
) -> BTreeSet<ScopedConversationKey> {
    let mut merged = incoming_flow.possible_codex_conversations.clone();
    for possibles in case_possibles {
        merged.extend(possibles);
    }
    merged
}

pub(super) fn possible_codex_conversations_visible_after_node(
    node_possibles: &BTreeSet<ScopedConversationKey>,
    node: &ValidatedNode,
) -> BTreeSet<ScopedConversationKey> {
    match &node.kind {
        rigg_core::NodeKind::Loop(_) => node_possibles
            .iter()
            .filter(|key| conversation_owner_survives_node(&key.scope, &node.path))
            .cloned()
            .collect(),
        rigg_core::NodeKind::Action(_)
        | rigg_core::NodeKind::Group(_)
        | rigg_core::NodeKind::Branch(_)
        | rigg_core::NodeKind::Parallel(_) => node_possibles.clone(),
    }
}

fn conversation_owner_survives_node(owner: &ScopedConversationOwner, node_path: &NodePath) -> bool {
    !matches!(
        owner,
        ScopedConversationOwner::Loop(path) | ScopedConversationOwner::Iteration(path)
            if path == node_path
    )
}

fn scoped_conversation_key(
    binding: &ConversationBinding,
    current_loop_path: Option<&NodePath>,
) -> Option<ScopedConversationKey> {
    let scope = match binding.scope {
        ConversationScope::Workflow => ScopedConversationOwner::Workflow,
        ConversationScope::Loop => ScopedConversationOwner::Loop(current_loop_path?.clone()),
        ConversationScope::Iteration => {
            ScopedConversationOwner::Iteration(current_loop_path?.clone())
        }
    };
    Some(ScopedConversationKey { name: binding.name.clone(), scope })
}

fn scoped_conversation_key_for_node(
    site: FieldSite<'_>,
    node: &ValidatedNode,
    binding: &ConversationBinding,
    current_loop_path: Option<&NodePath>,
) -> Result<ScopedConversationKey, ConfigError> {
    scoped_conversation_key(binding, current_loop_path).ok_or_else(|| {
        invalid_node_with(
            site,
            node.kind.label(),
            format!("`conversation.scope: {}` is only allowed inside a `loop` body", binding.scope),
        )
    })
}

fn invalid_node_with(site: FieldSite<'_>, step_type: &str, message: String) -> ConfigError {
    ConfigError::InvalidWith {
        path: site.path.to_path_buf(),
        location: site.location,
        workflow_id: site.workflow_id.to_string(),
        step_index: site.step_index,
        step_type: step_type.to_owned(),
        message,
    }
}
