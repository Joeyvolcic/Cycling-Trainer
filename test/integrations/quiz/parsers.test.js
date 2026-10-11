import {
    parseDelimitedRows, parseDelimited, parseAnki, parseNotes, sniffFormat, parseImport, stripHtml,
} from '../../../src/integrations/quiz/parsers.js';

describe('CSV / TSV', () => {
    test('quoted fields with commas, escaped quotes and newlines', () => {
        const rows = parseDelimitedRows('a,"b, c"\n"he said ""hi""","multi\nline"\n');
        expect(rows).toEqual([['a', 'b, c'], ['he said "hi"', 'multi\nline']]);
    });
    test('header row skipped, tags column, blank lines ignored', () => {
        const cards = parseDelimited('front,back,tags\nCapital of France,Paris,geo\n\nH2O,Water,\n');
        expect(cards).toEqual([
            { front: 'Capital of France', back: 'Paris', tags: 'geo' },
            { front: 'H2O', back: 'Water', tags: '' },
        ]);
    });
    test('TSV sniffed', () => {
        expect(parseImport('one\tuno\ntwo\tdos')).toEqual([
            { front: 'one', back: 'uno', tags: '' }, { front: 'two', back: 'dos', tags: '' },
        ]);
    });
});

describe('Anki plain text export', () => {
    test('headers, html, tags column, cloze', () => {
        const text = [
            '#separator:tab',
            '#html:true',
            '#tags column:3',
            'What is <b>ATP</b>?\tEnergy currency<br>of the cell\tbio',
            'The {{c1::heart}} pumps blood\t\tbio anatomy',
        ].join('\n');
        expect(sniffFormat(text)).toBe('anki');
        const cards = parseAnki(text);
        expect(cards[0]).toEqual({ front: 'What is ATP?', back: 'Energy currency\nof the cell', tags: 'bio' });
        expect(cards[1]).toEqual({ type: 'cloze', text: 'The {{c1::heart}} pumps blood', back: '', tags: 'bio anatomy' });
    });
    test('stripHtml entities', () => {
        expect(stripHtml('a&nbsp;&lt;b&gt; &amp; c')).toBe('a <b> & c');
    });
});

describe('Notes / Markdown', () => {
    test('Q/A, term :: def, cloze, MCQ', () => {
        const text = `# Physiology
Q: What does VO2max measure?
A: Maximal oxygen uptake
which is limited by cardiac output

- Lactate threshold :: intensity where lactate accumulates
- Fat is oxidised mainly at {{c1::low}} intensity

**Q:** Which fibre type is most oxidative?
- [ ] Type IIx
- [x] Type I
- [ ] Type IIa
`;
        expect(sniffFormat(text)).toBe('notes');
        const cards = parseNotes(text);
        expect(cards).toEqual([
            { front: 'What does VO2max measure?', back: 'Maximal oxygen uptake\nwhich is limited by cardiac output' },
            { front: 'Lactate threshold', back: 'intensity where lactate accumulates' },
            { type: 'cloze', text: 'Fat is oxidised mainly at {{c1::low}} intensity' },
            { type: 'mcq', front: 'Which fibre type is most oxidative?', choices: ['Type IIx', 'Type I', 'Type IIa'], answer: 1, back: '' },
        ]);
    });
    test('headings as cards (opt-in)', () => {
        const text = '## Krebs cycle\nOccurs in the mitochondrial matrix.\n\n## Glycolysis\nOccurs in the cytosol.';
        expect(parseNotes(text)).toEqual([]);
        expect(parseNotes(text, { headings: true })).toEqual([
            { front: 'Krebs cycle', back: 'Occurs in the mitochondrial matrix.' },
            { front: 'Glycolysis', back: 'Occurs in the cytosol.' },
        ]);
    });
    test('JSON passthrough', () => {
        expect(parseImport('{"cards":[{"front":"a","back":"b"}]}')).toEqual([{ front: 'a', back: 'b' }]);
    });
});
