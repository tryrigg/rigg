use super::ExecutorError;
use super::context::FrameContext;
use crate::state::RunState;
use crate::{
    ConversationBinding, ConversationHandle, ConversationName, ConversationScope, FrameId,
    LoopScopeId,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default)]
pub(super) struct ConversationState {
    workflow: BTreeMap<ConversationName, ConversationHandle>,
    loop_scopes: BTreeMap<LoopScopeId, BTreeMap<ConversationName, ConversationHandle>>,
    iteration_scopes: BTreeMap<FrameId, BTreeMap<ConversationName, ConversationHandle>>,
}

impl ConversationState {
    pub(super) fn lookup<'a>(
        &'a self,
        frame: &FrameContext,
        binding: &ConversationBinding,
    ) -> Option<&'a ConversationHandle> {
        match binding.scope {
            ConversationScope::Workflow => self.workflow.get(&binding.name),
            ConversationScope::Loop => frame
                .loop_scope_id()
                .and_then(|scope| self.loop_scopes.get(scope))
                .and_then(|conversations| conversations.get(&binding.name)),
            ConversationScope::Iteration => self
                .iteration_scopes
                .get(frame.iteration_frame_id())
                .and_then(|conversations| conversations.get(&binding.name)),
        }
    }

    pub(super) fn store(
        &mut self,
        run_state: &mut RunState,
        frame: &FrameContext,
        binding: &ConversationBinding,
        handle: ConversationHandle,
    ) {
        match binding.scope {
            ConversationScope::Workflow => {
                run_state.workflow_conversations.insert(binding.name.clone(), handle.clone());
                self.workflow.insert(binding.name.clone(), handle);
            }
            ConversationScope::Loop => {
                if let Some(scope) = frame.loop_scope_id() {
                    self.loop_scopes
                        .entry(scope.clone())
                        .or_default()
                        .insert(binding.name.clone(), handle);
                }
            }
            ConversationScope::Iteration => {
                self.iteration_scopes
                    .entry(frame.iteration_frame_id().clone())
                    .or_default()
                    .insert(binding.name.clone(), handle);
            }
        }
    }

    pub(super) fn clear_iteration(&mut self, frame: &FrameContext) {
        self.iteration_scopes.remove(frame.iteration_frame_id());
    }

    pub(super) fn clear_loop(&mut self, loop_scope_id: &LoopScopeId) {
        self.loop_scopes.remove(loop_scope_id);
    }

    pub(super) fn merge_parallel_branch(
        &mut self,
        run_state: &mut RunState,
        base: &Self,
        branch: &Self,
    ) -> Result<(), ExecutorError> {
        merge_scope_updates(&mut self.workflow, &base.workflow, &branch.workflow, |_| {
            "workflow".to_owned()
        })?;
        merge_nested_scope_updates(
            &mut self.loop_scopes,
            &base.loop_scopes,
            &branch.loop_scopes,
            |scope, _| scope.to_string(),
        )?;
        merge_nested_scope_updates(
            &mut self.iteration_scopes,
            &base.iteration_scopes,
            &branch.iteration_scopes,
            |scope, _| scope.to_string(),
        )?;
        run_state.workflow_conversations = self.workflow.clone();
        Ok(())
    }
}

fn merge_scope_updates(
    current: &mut BTreeMap<ConversationName, ConversationHandle>,
    base: &BTreeMap<ConversationName, ConversationHandle>,
    branch: &BTreeMap<ConversationName, ConversationHandle>,
    scope_name: impl Fn(&ConversationName) -> String,
) -> Result<(), ExecutorError> {
    for (name, handle) in branch {
        if base.get(name) == Some(handle) {
            continue;
        }
        match current.get(name) {
            Some(existing) if existing == handle => {}
            Some(existing) if base.get(name) == Some(existing) => {
                current.insert(name.clone(), handle.clone());
            }
            None => {
                current.insert(name.clone(), handle.clone());
            }
            Some(_) => {
                let scope = scope_name(name);
                return Err(ExecutorError::ParallelConversationConflict {
                    name: name.to_string(),
                    scope,
                });
            }
        }
    }
    Ok(())
}

fn merge_nested_scope_updates<K>(
    current: &mut BTreeMap<K, BTreeMap<ConversationName, ConversationHandle>>,
    base: &BTreeMap<K, BTreeMap<ConversationName, ConversationHandle>>,
    branch: &BTreeMap<K, BTreeMap<ConversationName, ConversationHandle>>,
    scope_name: impl Fn(&K, &ConversationName) -> String,
) -> Result<(), ExecutorError>
where
    K: Clone + Ord,
{
    for (owner, branch_conversations) in branch {
        let base_conversations = base.get(owner);
        let current_conversations = current.entry(owner.clone()).or_default();
        for (name, handle) in branch_conversations {
            if base_conversations.and_then(|base| base.get(name)) == Some(handle) {
                continue;
            }
            match current_conversations.get(name) {
                Some(existing) if existing == handle => {}
                Some(existing)
                    if base_conversations.and_then(|base| base.get(name)) == Some(existing) =>
                {
                    current_conversations.insert(name.clone(), handle.clone());
                }
                None => {
                    current_conversations.insert(name.clone(), handle.clone());
                }
                Some(_) => {
                    let scope = scope_name(owner, name);
                    return Err(ExecutorError::ParallelConversationConflict {
                        name: name.to_string(),
                        scope,
                    });
                }
            }
        }
    }
    Ok(())
}
