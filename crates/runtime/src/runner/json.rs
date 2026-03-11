pub(super) fn extract_top_level_json_field<'a>(text: &'a str, field: &str) -> Option<&'a str> {
    let bytes = text.as_bytes();
    let mut index = skip_json_ws(bytes, 0);
    if *bytes.get(index)? != b'{' {
        return None;
    }
    index += 1;

    loop {
        index = skip_json_ws(bytes, index);
        match bytes.get(index)? {
            b'}' => return None,
            b'"' => {}
            _ => return None,
        }

        let key_start = index + 1;
        let key_end = scan_json_string(bytes, index)?;
        let key = &text[key_start..key_end];
        index = skip_json_ws(bytes, key_end + 1);
        if *bytes.get(index)? != b':' {
            return None;
        }
        index = skip_json_ws(bytes, index + 1);

        let value_start = index;
        let value_end = scan_json_value(bytes, value_start)?;
        if key == field {
            return Some(text[value_start..value_end].trim());
        }

        index = skip_json_ws(bytes, value_end);
        match bytes.get(index)? {
            b',' => index += 1,
            b'}' => return None,
            _ => return None,
        }
    }
}

fn skip_json_ws(bytes: &[u8], mut index: usize) -> usize {
    while let Some(byte) = bytes.get(index) {
        if !matches!(byte, b' ' | b'\n' | b'\r' | b'\t') {
            break;
        }
        index += 1;
    }
    index
}

fn scan_json_string(bytes: &[u8], start: usize) -> Option<usize> {
    if *bytes.get(start)? != b'"' {
        return None;
    }

    let mut index = start + 1;
    while let Some(byte) = bytes.get(index) {
        match byte {
            b'\\' => index += 2,
            b'"' => return Some(index),
            _ => index += 1,
        }
    }
    None
}

fn scan_json_value(bytes: &[u8], start: usize) -> Option<usize> {
    match bytes.get(start)? {
        b'"' => scan_json_string(bytes, start).map(|end| end + 1),
        b'{' | b'[' => scan_json_compound(bytes, start),
        b'-' | b'0'..=b'9' => Some(scan_json_literal(bytes, start)),
        b't' if bytes.get(start..start + 4) == Some(b"true") => Some(start + 4),
        b'f' if bytes.get(start..start + 5) == Some(b"false") => Some(start + 5),
        b'n' if bytes.get(start..start + 4) == Some(b"null") => Some(start + 4),
        _ => None,
    }
}

fn scan_json_compound(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = start;

    while let Some(byte) = bytes.get(index) {
        match byte {
            b'"' => index = scan_json_string(bytes, index)?,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn scan_json_literal(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while let Some(byte) = bytes.get(index) {
        if matches!(byte, b' ' | b'\n' | b'\r' | b'\t' | b',' | b'}' | b']') {
            break;
        }
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::extract_top_level_json_field;

    #[test]
    fn extracts_raw_top_level_json_field_text() {
        let text = r#"{"type":"result","structured_output": { "markdown" : "ok", "flag" : true }}"#;

        assert_eq!(
            extract_top_level_json_field(text, "structured_output"),
            Some(r#"{ "markdown" : "ok", "flag" : true }"#)
        );
    }
}
