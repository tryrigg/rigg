use super::lock;
use std::sync::Mutex;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct FixedClock;

impl crate::Clock for FixedClock {
    fn now(&self) -> String {
        "2026-01-01T00:00:00Z".to_owned()
    }
}

#[derive(Debug)]
pub(crate) struct AdvancingClock {
    next: Mutex<OffsetDateTime>,
}

impl AdvancingClock {
    pub(crate) fn new(start: &str) -> Self {
        let next = OffsetDateTime::parse(start, &Rfc3339).expect("valid RFC3339 timestamp");
        Self { next: Mutex::new(next) }
    }
}

impl crate::Clock for AdvancingClock {
    fn now(&self) -> String {
        let mut next = lock(&self.next);
        let current = *next;
        *next = current + Duration::seconds(1);
        current.format(&Rfc3339).expect("timestamp formatting should succeed")
    }
}
