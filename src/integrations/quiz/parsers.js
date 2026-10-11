//
// Importers — pure text -> raw card objects (pass the result through cards.makeCards).
//
//   parseDelimited(text)  CSV / TSV: "front,back[,tags]" with RFC-4180 quoting
//   parseAnki(text)       Anki "Notes in Plain Text" export (#separator, #html, #tags column)
//   parseNotes(text)      Markdown / free notes:
//                           Q: question / A: answer          (multi-line answers OK)
//                           term :: definition
//                           any line with {{c1::cloze}}
//                           Q: question + "- [ ] wrong" / "- [x] right"  -> multiple choice
//                           "## Heading" + paragraph         (opt-in: headings: true)
//   parseImport(text)     sniff the format and dispatch
//

function splitDelimitedLine(line, delimiter) {
    // single physical line; quotes handled by parseDelimitedRows for multi-line
    return parseDelimitedRows(line, delimiter)[0] || [];
}

// RFC-4180-ish: supports quoted fields containing delimiters, "" escapes and newlines
function parseDelimitedRows(text, delimiter = ',') {
    const rows = [];
    let row = [], field = '', inQuotes = false, i = 0;
    const s = String(text).replace(/\r\n?/g, '\n');
    while(i < s.length) {
        const ch = s[i];
        if(inQuotes) {
            if(ch === '"') {
                if(s[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if(ch === '"' && field === '') { inQuotes = true; i++; continue; }
        if(ch === delimiter) { row.push(field); field = ''; i++; continue; }
        if(ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += ch; i++;
    }
    if(field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f.trim() !== ''));
}

function sniffDelimiter(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).slice(0, 20);
    const count = (ch) => lines.filter(l => l.includes(ch)).length;
    if(count('\t') > 0 && count('\t') >= lines.length / 2) return '\t';
    if(count(';') > count(',')) return ';';
    return ',';
}

function isHeader(row) {
    const a = (row[0] || '').trim().toLowerCase();
    const b = (row[1] || '').trim().toLowerCase();
    return ['front', 'question', 'q', 'term'].includes(a) &&
           ['back', 'answer', 'a', 'definition'].includes(b);
}

function rowToRaw(row) {
    const [front = '', back = '', tags = ''] = row.map(f => f.trim());
    return { front, back, tags };
}

function parseDelimited(text, delimiter = null) {
    const d = delimiter || sniffDelimiter(text);
    const rows = parseDelimitedRows(text, d);
    if(rows.length && isHeader(rows[0])) rows.shift();
    return rows.map(rowToRaw).filter(r => r.front && (r.back || /\{\{c\d+::/.test(r.front)));
}

function stripHtml(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|p|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Anki: File > Export > "Notes in Plain Text (.txt)"
function parseAnki(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const header = {};
    const body = [];
    for(const line of lines) {
        const m = line.match(/^#([a-z ]+):(.*)$/i);
        if(m && body.length === 0) { header[m[1].trim().toLowerCase()] = m[2].trim(); continue; }
        body.push(line);
    }
    const sepName = (header.separator || 'tab').toLowerCase();
    const sep = {tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':'}[sepName] ||
                header.separator || '\t';
    const html = String(header.html || 'false').toLowerCase() === 'true' ||
                 /<[a-z][^>]*>/i.test(body.join('\n'));
    const tagsCol = header['tags column'] ? parseInt(header['tags column']) - 1 : -1;
    // skip guid / notetype / deck columns if declared
    const skip = new Set(['guid column', 'notetype column', 'deck column']
                         .filter(k => header[k]).map(k => parseInt(header[k]) - 1));

    const rows = parseDelimitedRows(body.join('\n'), sep);
    return rows.map(row => {
        const fields = row.filter((_, i) => !skip.has(i) && i !== tagsCol)
                          .map(f => html ? stripHtml(f) : f.trim());
        const tags = tagsCol >= 0 ? (row[tagsCol] || '').trim() : '';
        const [front = '', back = ''] = fields;
        if(/\{\{c\d+::/.test(front)) return { type: 'cloze', text: front, back, tags };
        return { front, back, tags };
    }).filter(r => (r.type === 'cloze' && r.text) || (r.front && r.back));
}

function parseNotes(text, {headings = false} = {}) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let cur = null;      // {front, back[], choices[], answer}
    let heading = null;  // {front, body[]}

    const flush = () => {
        if(cur) {
            const back = cur.back.join('\n').trim();
            if(cur.choices.length >= 2 && cur.answer >= 0) {
                out.push({ type: 'mcq', front: cur.front, choices: cur.choices, answer: cur.answer, back });
            } else if(cur.front && back) {
                out.push({ front: cur.front, back });
            }
            cur = null;
        }
        if(heading) {
            const back = heading.body.join('\n').trim();
            if(heading.front && back) out.push({ front: heading.front, back });
            heading = null;
        }
    };

    for(const raw of lines) {
        const line = raw.trim();
        let m;
        if((m = line.match(/^(?:[-*]\s+)?(?:\*\*)?Q(?:uestion)?\s*[:.)](?:\*\*)?\s*(.+)$/i))) {
            flush();
            cur = { front: m[1].trim(), back: [], choices: [], answer: -1 };
            continue;
        }
        if(cur && (m = line.match(/^(?:[-*]\s+)?(?:\*\*)?A(?:nswer)?\s*[:.)](?:\*\*)?\s*(.*)$/i))) {
            cur.back.push(m[1]);
            continue;
        }
        if(cur && (m = line.match(/^[-*]\s+\[( |x|X)\]\s+(.+)$/))) {
            if(m[1].toLowerCase() === 'x') cur.answer = cur.choices.length;
            cur.choices.push(m[2].trim());
            continue;
        }
        if(cur && line && cur.back.length > 0) { cur.back.push(line); continue; }
        if(!line) {
            if(cur && (cur.back.length > 0 || cur.choices.length > 0)) flush();
            continue;
        }
        if(headings && (m = line.match(/^#{1,6}\s+(.+)$/))) {
            flush();
            heading = { front: m[1].trim(), body: [] };
            continue;
        }
        const body = line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '');
        if(/\{\{c\d+::/.test(body)) {
            flush();
            out.push({ type: 'cloze', text: body });
            continue;
        }
        if((m = body.match(/^(.+?)\s+::\s+(.+)$/))) {
            flush();
            out.push({ front: m[1].trim(), back: m[2].trim() });
            continue;
        }
        if(heading) { heading.body.push(body); continue; }
    }
    flush();
    return out;
}

function sniffFormat(text) {
    const s = String(text).trim();
    if(/^[{[]/.test(s)) return 'json';
    if(/^#(separator|html|tags column|notetype|deck)\s*:/im.test(s)) return 'anki';
    if(/^\s*(?:[-*]\s+)?(?:\*\*)?Q(?:uestion)?\s*[:.)]/im.test(s) || /\s::\s/.test(s) ||
       /^#{1,6}\s/m.test(s)) return 'notes';
    const lines = s.split('\n').filter(Boolean);
    if(lines.length && lines.filter(l => l.includes('\t')).length >= lines.length / 2) return 'tsv';
    if(lines.length && lines.filter(l => /,|;/.test(l)).length >= lines.length / 2) return 'csv';
    return 'notes';
}

function parseImport(text, format = 'auto', opts = {}) {
    const f = format === 'auto' ? sniffFormat(text) : format;
    switch(f) {
    case 'anki':  return parseAnki(text);
    case 'tsv':   return parseDelimited(text, '\t');
    case 'csv':   return parseDelimited(text);
    case 'notes': return parseNotes(text, opts);
    case 'json': {
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : (data.cards || []);
    }
    default:      return parseNotes(text, opts);
    }
}

export {
    parseDelimitedRows,
    splitDelimitedLine,
    sniffDelimiter,
    parseDelimited,
    stripHtml,
    parseAnki,
    parseNotes,
    sniffFormat,
    parseImport,
};
