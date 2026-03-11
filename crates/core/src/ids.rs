use std::fmt::{Display, Formatter};
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdError {
    #[error("identifier cannot be empty")]
    Empty,
    #[error("identifier `{value}` must start with an ASCII letter or `_`")]
    InvalidStart { value: String },
    #[error("identifier `{value}` contains invalid character `{character}`")]
    InvalidCharacter { value: String, character: char },
    #[error("run id `{value}` is not a valid UUID: {source}")]
    InvalidRunId {
        value: String,
        #[source]
        source: uuid::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorkflowId(String);

impl WorkflowId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for WorkflowId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_identifier(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for WorkflowId {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for WorkflowId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for WorkflowId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StepId(String);

impl StepId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for StepId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_identifier(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for StepId {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for StepId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for StepId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(String);

impl NodeId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn generated(index: usize) -> Self {
        Self(format!("node_{index}"))
    }
}

impl TryFrom<String> for NodeId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_identifier(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for NodeId {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for NodeId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for NodeId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NodePath(String);

impl NodePath {
    pub fn root_child(index: usize) -> Self {
        Self(format!("/{index}"))
    }

    pub fn child(&self, index: usize) -> Self {
        Self(format!("{}/{}", self.0, index))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn file_component(&self) -> String {
        self.0
            .split('/')
            .skip(1)
            .map(|segment| format!("s{:08x}_{segment}", segment.len()))
            .collect()
    }

    pub fn from_file_component(value: &str) -> Result<Self, IdError> {
        let mut rest = value;
        let mut path = String::new();

        while !rest.is_empty() {
            if !rest.starts_with('s') {
                return Err(IdError::InvalidCharacter {
                    value: value.to_owned(),
                    character: rest.chars().next().unwrap_or_default(),
                });
            }
            if rest.len() < 10 {
                return Err(IdError::InvalidCharacter { value: value.to_owned(), character: 's' });
            }

            let length_hex = &rest[1..9];
            let segment_length = usize::from_str_radix(length_hex, 16).map_err(|_| {
                IdError::InvalidCharacter { value: value.to_owned(), character: 's' }
            })?;
            if rest.as_bytes()[9] != b'_' {
                return Err(IdError::InvalidCharacter {
                    value: value.to_owned(),
                    character: rest[9..].chars().next().unwrap_or('_'),
                });
            }
            let segment_start = 10;
            let segment_end = segment_start + segment_length;
            if rest.len() < segment_end {
                return Err(IdError::InvalidCharacter { value: value.to_owned(), character: 's' });
            }

            path.push('/');
            path.push_str(&rest[segment_start..segment_end]);
            rest = &rest[segment_end..];
        }

        Self::try_from(path)
    }
}

impl TryFrom<String> for NodePath {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_node_path(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for NodePath {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for NodePath {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for NodePath {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl PartialOrd for NodePath {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for NodePath {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let mut left = self.0.split('/').skip(1);
        let mut right = other.0.split('/').skip(1);

        loop {
            match (left.next(), right.next()) {
                (Some(left), Some(right)) => {
                    let ordering = match (left.parse::<usize>(), right.parse::<usize>()) {
                        (Ok(left), Ok(right)) => left.cmp(&right),
                        _ => left.cmp(right),
                    };
                    if !ordering.is_eq() {
                        return ordering;
                    }
                }
                (Some(_), None) => return std::cmp::Ordering::Greater,
                (None, Some(_)) => return std::cmp::Ordering::Less,
                (None, None) => return std::cmp::Ordering::Equal,
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConversationName(String);

impl ConversationName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ConversationName {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_conversation_name(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for ConversationName {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for ConversationName {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for ConversationName {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LoopScopeId {
    parent: Box<FrameId>,
    node_path: NodePath,
}

impl LoopScopeId {
    fn child(parent: &FrameId, node_path: &NodePath) -> Self {
        Self { parent: Box::new(parent.clone()), node_path: node_path.clone() }
    }
}

impl Display for LoopScopeId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.loop.{}", self.parent, self.node_path.file_component())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrameId {
    Root,
    LoopIteration { scope: LoopScopeId, iteration: u32 },
    ParallelBranch { parent: Box<FrameId>, node_path: NodePath, branch_index: usize },
}

impl FrameId {
    pub fn root() -> Self {
        Self::Root
    }

    pub fn child_loop_scope(&self, node_path: &NodePath) -> LoopScopeId {
        LoopScopeId::child(self, node_path)
    }

    pub fn for_loop_iteration(loop_scope: &LoopScopeId, iteration: u32) -> Self {
        Self::LoopIteration { scope: loop_scope.clone(), iteration }
    }

    pub fn for_parallel_branch(parent: &Self, node_path: &NodePath, branch_index: usize) -> Self {
        Self::ParallelBranch {
            parent: Box::new(parent.clone()),
            node_path: node_path.clone(),
            branch_index,
        }
    }
}

impl Default for FrameId {
    fn default() -> Self {
        Self::root()
    }
}

impl TryFrom<String> for FrameId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_str(&value)
    }
}

impl TryFrom<&str> for FrameId {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_str(value)
    }
}

impl FromStr for FrameId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        parse_frame_id(value)
            .ok_or_else(|| IdError::InvalidCharacter { value: value.to_owned(), character: '.' })
    }
}

impl Display for FrameId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Root => formatter.write_str("root"),
            Self::LoopIteration { scope, iteration } => {
                write!(formatter, "{scope}.iter.{iteration}")
            }
            Self::ParallelBranch { parent, node_path, branch_index } => {
                write!(
                    formatter,
                    "{parent}.parallel.{}.branch.{branch_index}",
                    node_path.file_component()
                )
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RunId(String);

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

impl RunId {
    pub fn new() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for RunId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parsed = Uuid::parse_str(&value)
            .map_err(|source| IdError::InvalidRunId { value: value.clone(), source })?;
        Ok(Self(parsed.hyphenated().to_string()))
    }
}

impl TryFrom<&str> for RunId {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for RunId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for RunId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn validate_identifier(value: &str) -> Result<(), IdError> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(IdError::Empty);
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(IdError::InvalidStart { value: value.to_owned() });
    }
    if let Some(character) =
        chars.find(|ch| !(ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-'))
    {
        return Err(IdError::InvalidCharacter { value: value.to_owned(), character });
    }
    Ok(())
}

fn validate_conversation_name(value: &str) -> Result<(), IdError> {
    if value.trim().is_empty() {
        return Err(IdError::Empty);
    }
    Ok(())
}

fn validate_node_path(value: &str) -> Result<(), IdError> {
    if value.is_empty() {
        return Err(IdError::Empty);
    }
    if !value.starts_with('/') {
        return Err(IdError::InvalidStart { value: value.to_owned() });
    }
    Ok(())
}

fn parse_frame_id(value: &str) -> Option<FrameId> {
    let mut parts = value.split('.');
    let mut frame = match parts.next()? {
        "root" => FrameId::Root,
        _ => return None,
    };

    while let Some(part) = parts.next() {
        match part {
            "loop" => {
                let node_path = NodePath::from_file_component(parts.next()?).ok()?;
                let scope = frame.child_loop_scope(&node_path);
                if parts.next()? != "iter" {
                    return None;
                }
                let iteration = parts.next()?.parse().ok()?;
                frame = FrameId::LoopIteration { scope, iteration };
            }
            "parallel" => {
                let node_path = NodePath::from_file_component(parts.next()?).ok()?;
                if parts.next()? != "branch" {
                    return None;
                }
                let branch_index = parts.next()?.parse().ok()?;
                frame =
                    FrameId::ParallelBranch { parent: Box::new(frame), node_path, branch_index };
            }
            _ => return None,
        }
    }

    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::{ConversationName, FrameId, IdError, NodeId, NodePath, RunId, StepId, WorkflowId};

    #[test]
    fn workflow_id_rejects_invalid_identifiers() {
        assert!(matches!(WorkflowId::try_from(""), Err(IdError::Empty)));
        assert!(matches!(WorkflowId::try_from("9plan"), Err(IdError::InvalidStart { .. })));
        assert!(matches!(WorkflowId::try_from("bad name"), Err(IdError::InvalidCharacter { .. })));
    }

    #[test]
    fn step_id_accepts_valid_identifier() -> Result<(), IdError> {
        let step_id = StepId::try_from("review-branch")?;
        assert_eq!(step_id.as_str(), "review-branch");
        Ok(())
    }

    #[test]
    fn node_id_accepts_valid_identifier() -> Result<(), IdError> {
        let node_id = NodeId::try_from("node_0")?;
        assert_eq!(node_id.as_str(), "node_0");
        Ok(())
    }

    #[test]
    fn node_path_requires_leading_slash() {
        assert!(matches!(NodePath::try_from("0"), Err(IdError::InvalidStart { .. })));
    }

    #[test]
    fn node_path_orders_numeric_segments_structurally() -> Result<(), IdError> {
        let mut paths = vec![
            NodePath::try_from("/10")?,
            NodePath::try_from("/2")?,
            NodePath::try_from("/1/10")?,
            NodePath::try_from("/1/2")?,
        ];

        paths.sort();

        assert_eq!(
            paths.into_iter().map(|path| path.to_string()).collect::<Vec<_>>(),
            vec!["/1/2", "/1/10", "/2", "/10"]
        );
        Ok(())
    }

    #[test]
    fn node_path_file_component_round_trips() -> Result<(), IdError> {
        let path = NodePath::try_from("/1/10/2")?;
        let encoded = path.file_component();

        assert_eq!(NodePath::from_file_component(&encoded)?, path);
        Ok(())
    }

    #[test]
    fn node_path_file_component_sorts_in_structural_order() -> Result<(), IdError> {
        let mut components = vec![
            NodePath::try_from("/10")?.file_component(),
            NodePath::try_from("/2")?.file_component(),
            NodePath::try_from("/1/10")?.file_component(),
            NodePath::try_from("/1/2")?.file_component(),
        ];

        components.sort();

        assert_eq!(
            components
                .into_iter()
                .map(|component| NodePath::from_file_component(&component))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|path| path.to_string())
                .collect::<Vec<_>>(),
            vec!["/1/2", "/1/10", "/2", "/10"]
        );
        Ok(())
    }

    #[test]
    fn conversation_name_accepts_valid_identifier() -> Result<(), IdError> {
        let conversation = ConversationName::try_from("reviewer_1")?;
        assert_eq!(conversation.as_str(), "reviewer_1");
        Ok(())
    }

    #[test]
    fn conversation_name_accepts_labels_that_are_not_identifiers() -> Result<(), IdError> {
        let conversation = ConversationName::try_from("123 reviewer / main")?;
        assert_eq!(conversation.as_str(), "123 reviewer / main");
        Ok(())
    }

    #[test]
    fn conversation_name_rejects_blank_labels() {
        assert!(matches!(ConversationName::try_from("   "), Err(IdError::Empty)));
    }

    #[test]
    fn frame_id_accepts_loop_iteration_paths() -> Result<(), IdError> {
        let scope = FrameId::root().child_loop_scope(&NodePath::try_from("/1/2")?);
        let frame = FrameId::for_loop_iteration(&scope, 3);

        assert_eq!(frame.to_string(), "root.loop.s00000001_1s00000001_2.iter.3");
        Ok(())
    }

    #[test]
    fn frame_id_orders_loop_iterations_numerically() -> Result<(), IdError> {
        let scope = FrameId::root().child_loop_scope(&NodePath::try_from("/0")?);
        let mut frames = vec![
            FrameId::for_loop_iteration(&scope, 10),
            FrameId::for_loop_iteration(&scope, 2),
            FrameId::root(),
        ];

        frames.sort();

        assert_eq!(
            frames.into_iter().map(|frame| frame.to_string()).collect::<Vec<_>>(),
            vec!["root", "root.loop.s00000001_0.iter.2", "root.loop.s00000001_0.iter.10"]
        );
        Ok(())
    }

    #[test]
    fn frame_id_accepts_parallel_branch_paths() -> Result<(), IdError> {
        let frame = FrameId::for_parallel_branch(&FrameId::root(), &NodePath::try_from("/1")?, 2);

        assert_eq!(frame.to_string(), "root.parallel.s00000001_1.branch.2");
        Ok(())
    }

    #[test]
    fn run_id_parse_normalizes_uuid() -> Result<(), IdError> {
        let run_id: RunId = "018f7f8f-d6f2-7f2d-a5ae-6cb17d3fe3f8".parse()?;
        assert_eq!(run_id.as_str(), "018f7f8f-d6f2-7f2d-a5ae-6cb17d3fe3f8");
        Ok(())
    }
}
