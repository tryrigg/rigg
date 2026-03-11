use rigg_core::StreamKind;
use rigg_core::progress::StepProgressSink;

pub(super) use rigg_core::progress::ProviderEvent;

pub(super) struct ProgressEmitter<'a> {
    sink: &'a mut dyn StepProgressSink,
}

impl<'a> ProgressEmitter<'a> {
    pub(super) fn new(sink: &'a mut dyn StepProgressSink) -> Self {
        Self { sink }
    }

    pub(super) fn step_output(&mut self, stream: StreamKind, chunk: &str) {
        if !self.sink.is_enabled() || chunk.is_empty() {
            return;
        }
        self.sink.step_output(stream, chunk);
    }

    pub(super) fn emit_provider_events(&mut self, events: Vec<ProviderEvent>) {
        for event in events {
            if !self.sink.is_enabled() {
                return;
            }
            self.sink.provider_event(event);
        }
    }
}
