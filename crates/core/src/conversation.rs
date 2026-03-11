use std::fmt::{Display, Formatter};

use crate::ids::ConversationName;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationProvider {
    Claude,
    Codex,
}

impl ConversationProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

impl Display for ConversationProvider {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationScope {
    Iteration,
    Loop,
    Workflow,
}

impl ConversationScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Iteration => "iteration",
            Self::Loop => "loop",
            Self::Workflow => "workflow",
        }
    }
}

impl Display for ConversationScope {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationBinding {
    pub name: ConversationName,
    pub scope: ConversationScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationHandle {
    Claude { session_id: String },
    Codex { thread_id: String },
}

impl ConversationHandle {
    pub fn provider(&self) -> ConversationProvider {
        match self {
            Self::Claude { .. } => ConversationProvider::Claude,
            Self::Codex { .. } => ConversationProvider::Codex,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Claude { session_id } => session_id,
            Self::Codex { thread_id } => thread_id,
        }
    }

    pub fn claude_session_id(&self) -> Option<&str> {
        match self {
            Self::Claude { session_id } => Some(session_id),
            Self::Codex { .. } => None,
        }
    }

    pub fn codex_thread_id(&self) -> Option<&str> {
        match self {
            Self::Claude { .. } => None,
            Self::Codex { thread_id } => Some(thread_id),
        }
    }
}
