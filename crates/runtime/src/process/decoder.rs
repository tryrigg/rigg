#[derive(Debug, Default)]
pub(super) struct StreamDecoder {
    pending: Vec<u8>,
}

impl StreamDecoder {
    pub(super) fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        decode_pending_bytes(&mut self.pending, false)
    }

    pub(super) fn finish(&mut self) -> String {
        decode_pending_bytes(&mut self.pending, true)
    }
}

fn decode_pending_bytes(bytes: &mut Vec<u8>, flush_incomplete: bool) -> String {
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(valid) => {
                decoded.push_str(valid);
                bytes.clear();
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    decoded.push_str(String::from_utf8_lossy(&bytes[..valid_up_to]).as_ref());
                }

                match error.error_len() {
                    Some(error_len) => {
                        decoded.push(char::REPLACEMENT_CHARACTER);
                        bytes.drain(..valid_up_to + error_len);
                    }
                    None if flush_incomplete => {
                        decoded.push_str(&String::from_utf8_lossy(&bytes[valid_up_to..]));
                        bytes.clear();
                        break;
                    }
                    None => {
                        bytes.drain(..valid_up_to);
                        break;
                    }
                }
            }
        }
    }
    decoded
}
