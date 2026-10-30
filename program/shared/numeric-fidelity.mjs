const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const ORDINAL_WORD = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|twenty-ninth|thirtieth)';
const HYPHENATED_DIGIT_WORDS = new RegExp(`\\b${NUMBER_WORD}(?:-${NUMBER_WORD})+\\b`, 'giu');
const SPELLED_STREET = new RegExp(`\\b${ORDINAL_WORD}\\s+(?:Avenue|Street|Road|Highway|Boulevard|Drive|Lane|Line|Concession)\\b`, 'giu');

export function numericFidelityDefects(text = '') {
  const value = String(text || '');
  const malformedHyphenatedNumbers = Array.from(value.matchAll(HYPHENATED_DIGIT_WORDS), (match) => match[0])
    .filter((candidate) => {
      const parts = candidate.toLowerCase().split('-');
      return new Set(parts).size > 1;
    });
  return [
    ...malformedHyphenatedNumbers.map((candidate) => ({ kind: 'hyphenated-number-words', value: candidate })),
    ...Array.from(value.matchAll(SPELLED_STREET), (match) => ({ kind: 'spelled-street-ordinal', value: match[0] })),
  ];
}

export function assertNumericFidelity(text = '', label = 'generated prose') {
  const defects = numericFidelityDefects(text);
  if (defects.length) {
    throw new Error(`numeric fidelity gate: ${label} contains ${defects.map((row) => `"${row.value}"`).join(', ')}`);
  }
}

export function hasNumericFidelity(text = '') {
  return numericFidelityDefects(text).length === 0;
}
