// A faster drop-in for csv-reader 1.0.0: run(input) returns csv-reader's answer for every input,
// the reading of {text, header} as {columns, rows, errors} under csv-reader's broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one
//     quote, and each CRLF or lone CR inside it read as LF; what follows its closing quote, up to
//     the next comma or line break, is appended as it stands (quote_junk, when the field ends and
//     anything was appended); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows,
//     null for the header.
//
// Where csv-reader builds every field a character at a time, this scan slices each field (or each
// clean run inside it) out of the text in one piece and only assembles pieces when a field is
// actually broken: a stray CR inside it, escapes or line breaks inside its quotes, or junk after
// its closing quote. Pure: nothing is kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field scanners' results, kept in scratch variables so a field costs no result object.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `initial` up to the next comma or line break, starting at pos:
  // a CR not followed by LF is dropped (stray_cr). Sets fValue, fEnded and fAdded (the characters
  // this scan itself kept, which is what quote_junk is judged by).
  function scanUnquoted(initial) {
    let parts = null; // field pieces, once a stray CR splits the field
    let kept = 0; // characters kept before the current segment
    let segStart = pos;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ,
        pos = i + 1;
        fEnded = COMMA;
        break;
      }
      if (c === 10) { // LF
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        break;
      }
      if (c === 13) { // CR
        if (text.charCodeAt(i + 1) === 10) {
          pos = i + 2;
          line += 1;
          fEnded = LINE_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i));
        kept += i - segStart;
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (i >= n) {
      pos = n;
      fEnded = END;
    }
    fAdded = kept + (i - segStart);
    if (parts === null) {
      fValue = initial === '' ? text.slice(segStart, i) : initial + text.slice(segStart, i);
    } else {
      parts.push(text.slice(segStart, i));
      fValue = initial === '' ? parts.join('') : initial + parts.join('');
    }
  }

  // Pushes the run text[from, to) onto parts, reading each CRLF or lone CR inside it as one LF and
  // counting every line break it holds. Only called for runs that hold a CR or an LF.
  function pushRunWithBreaks(parts, from, to) {
    let seg = from;
    let j = from;
    while (j < to) {
      const c = text.charCodeAt(j);
      if (c === 13) { // CR: CRLF and a lone CR are each one LF
        if (seg < j) parts.push(text.slice(seg, j));
        parts.push('\n');
        line += 1;
        j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
        seg = j;
        continue;
      }
      if (c === 10) line += 1; // LF stays an LF; it is part of the current segment
      j += 1;
    }
    if (seg < to) parts.push(text.slice(seg, to));
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null; // field pieces, once an escape or a line break splits the field
    let segStart = open + 1; // the start of the clean run not yet copied into parts
    let i = open + 1;
    for (;;) {
      const idx = text.indexOf('"', i);
      if (idx === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        pos = open + 1;
        line = openLine;
        scanUnquoted('"');
        return;
      }
      // The run text[segStart, idx) before this quote: copy it, counting and reading its breaks.
      const rAt = text.indexOf('\r', segStart);
      const nAt = text.indexOf('\n', segStart);
      const hasBreak = (rAt !== -1 && rAt < idx) || (nAt !== -1 && nAt < idx);
      if (hasBreak) {
        if (parts === null) parts = [];
        pushRunWithBreaks(parts, segStart, idx);
      } else if (parts !== null) {
        if (segStart < idx) parts.push(text.slice(segStart, idx));
      }
      if (text.charCodeAt(idx + 1) === 34) { // "" inside the field is one quote
        if (parts === null) parts = [text.slice(segStart, idx)];
        parts.push('"');
        i = idx + 2;
        segStart = i;
        continue;
      }
      // The closing quote.
      fValue = parts === null ? text.slice(segStart, idx) : parts.join('');
      pos = idx + 1;
      if (pos >= n) {
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        pos += 1;
        fEnded = COMMA;
        return;
      }
      if (c === 10) { // LF
        pos += 1;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) { // CRLF
        pos += 2;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line
      // break (quote_junk, when anything was appended).
      const quotedValue = fValue;
      scanUnquoted(quotedValue);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fValue);
      ended = fEnded;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
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
}
