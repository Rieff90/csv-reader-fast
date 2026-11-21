// solve.js — a faster drop-in for csv-reader 1.0.0.
//
// csv-reader reads one character at a time and grows each field with `value += c`.
// In V8 that builds a *rope*: a chain of cons-strings that is cheap to extend but
// expensive to flatten, and JSON.stringify must flatten every one of them. This
// module keeps the same left-to-right reading and the same broken-row policy, but
// takes each field as one slice of the source text. A slice is a SlicedString:
// O(1) to make and already flat, so the stringify that follows is a straight copy.
//
// Every behaviour below is the reference's, including the ones that look like
// accidents: a CR outside quotes is dropped and reported; a quote that never
// closes is a literal character and its text is re-read as unquoted; text after a
// closing quote is appended and reported as quote_junk; a line that held only
// stray CRs is no record, but its errors stay.

const DELIM = /[,\n\r]/g;
const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

const C_COMMA = 44;
const C_LF = 10;
const C_CR = 13;
const C_QUOTE = 34;
const C_BOM = 0xfeff;

// Set by readUnquoted so readQuoted can tell whether anything followed the
// closing quote. A module-level number keeps the hot path free of allocation.
let appended = 0;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = len > 0 && text.charCodeAt(0) === C_BOM ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === C_LF) {
        pos++;
        line++;
      } else if (c === C_CR && pos + 1 < len && text.charCodeAt(pos + 1) === C_LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let ended;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === C_QUOTE;
      ended = quoted ? readQuoted(fields) : readUnquoted(fields, null, 0);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };

  // ---------------------------------------------------------------------------

  // A field that opens with a quote. Scans for the closing quote with indexOf,
  // skipping doubled quotes; when there is none the whole scan is thrown away and
  // the field is re-read as unquoted from just after the opening quote.
  function readQuoted(fields) {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let closeAt = -1;
    let doubled = false;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q < 0) break;
      if (q + 1 < len && text.charCodeAt(q + 1) === C_QUOTE) {
        doubled = true;
        p = q + 2;
        continue;
      }
      closeAt = q;
      break;
    }

    if (closeAt < 0) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted(fields, '"', 1);
    }

    let value;
    if (!doubled && !hasCR(text, open + 1, closeAt)) {
      // The common case: the body is a plain slice, and only LFs move the line.
      value = text.slice(open + 1, closeAt);
      line += countLFs(text, open + 1, closeAt);
    } else {
      // "" is one quote, and a CRLF or a lone CR inside quotes is one LF.
      value = '';
      for (let i = open + 1; i < closeAt; i++) {
        const c = text.charCodeAt(i);
        if (c === C_QUOTE) {
          value += '"';
          i++;
        } else if (c === C_CR) {
          value += '\n';
          line++;
          if (i + 1 < closeAt && text.charCodeAt(i + 1) === C_LF) i++;
        } else {
          if (c === C_LF) line++;
          value += text[i];
        }
      }
    }

    pos = closeAt + 1;
    if (pos >= len) {
      fields.push(value);
      return END;
    }
    const c = text.charCodeAt(pos);
    if (c === C_COMMA) {
      pos++;
      fields.push(value);
      return COMMA;
    }
    if (c === C_LF) {
      pos++;
      line++;
      fields.push(value);
      return LINE_BREAK;
    }
    if (c === C_CR && pos + 1 < len && text.charCodeAt(pos + 1) === C_LF) {
      pos += 2;
      line++;
      fields.push(value);
      return LINE_BREAK;
    }
    // Whatever follows the closing quote is appended as it stands.
    const ended = readUnquoted(fields, value, 0);
    if (appended > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return ended;
  }

  // An unquoted run from `pos`. `prefix` is the text the field already holds (null
  // for none) and `kept` how many characters that prefix contributed. A CR not
  // followed by LF is dropped and reported, and the run goes on.
  function readUnquoted(fields, prefix, kept) {
    let value = prefix;
    let count = kept;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      const endAt = m === null ? len : m.index;
      const c = m === null ? -1 : text.charCodeAt(endAt);

      if (c === C_CR && (endAt + 1 >= len || text.charCodeAt(endAt + 1) !== C_LF)) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const piece = text.slice(start, endAt);
        value = value === null ? piece : value + piece;
        count += endAt - start;
        pos = endAt + 1;
        start = pos;
        continue;
      }

      const piece = text.slice(start, endAt);
      count += endAt - start;
      value = value === null ? piece : value + piece;
      appended = count;

      if (c === C_COMMA) {
        pos = endAt + 1;
        fields.push(value);
        return COMMA;
      }
      if (c === C_LF) {
        pos = endAt + 1;
        line++;
        fields.push(value);
        return LINE_BREAK;
      }
      if (c === C_CR) {
        pos = endAt + 2;
        line++;
        fields.push(value);
        return LINE_BREAK;
      }
      pos = len;
      fields.push(value);
      return END;
    }
  }
}

// Whether a CR lies in [from, to). One indexOf, not a loop: the bodies are short.
function hasCR(text, from, to) {
  const at = text.indexOf('\r', from);
  return at !== -1 && at < to;
}

// The number of LFs in [from, to).
function countLFs(text, from, to) {
  let n = 0;
  let k = from;
  for (;;) {
    k = text.indexOf('\n', k);
    if (k === -1 || k >= to) return n;
    n++;
    k++;
  }
}
