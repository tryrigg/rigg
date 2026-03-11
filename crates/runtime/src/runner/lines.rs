#[derive(Debug, Default)]
pub(super) struct LineBuffer {
    pending: String,
}

impl LineBuffer {
    pub(super) fn push(&mut self, chunk: &str) -> Vec<String> {
        self.pending.push_str(chunk);
        let mut lines = Vec::new();

        while let Some(newline_index) = self.pending.find('\n') {
            let line = self.pending[..newline_index].trim_end_matches('\r').to_owned();
            self.pending.drain(..=newline_index);
            lines.push(line);
        }

        lines
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }

        let line = self.pending.trim_end_matches('\r').to_owned();
        self.pending.clear();
        Some(line)
    }
}

pub(super) fn preview(text: &str) -> String {
    text.replace('\n', "\\n")
}
