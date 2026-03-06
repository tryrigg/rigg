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
pub struct FlowName(String);

impl FlowName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for FlowName {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_identifier(&value)?;
        Ok(Self(value))
    }
}

impl TryFrom<&str> for FlowName {
    type Error = IdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl FromStr for FlowName {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl Display for FlowName {
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

#[cfg(test)]
mod tests {
    use super::{FlowName, IdError, RunId, StepId};

    #[test]
    fn flow_name_rejects_invalid_identifiers() {
        assert!(matches!(FlowName::try_from(""), Err(IdError::Empty)));
        assert!(matches!(FlowName::try_from("9plan"), Err(IdError::InvalidStart { .. })));
        assert!(matches!(FlowName::try_from("bad name"), Err(IdError::InvalidCharacter { .. })));
    }

    #[test]
    fn step_id_accepts_valid_identifier() -> Result<(), IdError> {
        let step_id = StepId::try_from("review-branch")?;
        assert_eq!(step_id.as_str(), "review-branch");
        Ok(())
    }

    #[test]
    fn run_id_parse_normalizes_uuid() -> Result<(), IdError> {
        let run_id: RunId = "018f7f8f-d6f2-7f2d-a5ae-6cb17d3fe3f8".parse()?;
        assert_eq!(run_id.as_str(), "018f7f8f-d6f2-7f2d-a5ae-6cb17d3fe3f8");
        Ok(())
    }
}
