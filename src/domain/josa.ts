const DIGIT_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']);
const LETTER_BATCHIM = new Set(['l', 'm', 'n', 'r']);

function hasBatchim(word: string): boolean {
  const s = word.replace(/[\s)\]}"'.,]+$/u, '');
  const ch = s.charAt(s.length - 1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (DIGIT_BATCHIM.has(ch)) return true;
  return LETTER_BATCHIM.has(ch.toLowerCase());
}

/** josa('행거', '이/가') → '행거가', josa('포토존', '을/를') → '포토존을' */
export function josa(word: string, pair: '이/가' | '을/를' | '은/는' | '과/와' | '으로/로'): string {
  const [withB, withoutB] = pair.split('/');
  if (pair === '으로/로') {
    const s = word.replace(/[\s)\]}"'.,]+$/u, '');
    const last = s.charAt(s.length - 1);
    const code = s.charCodeAt(s.length - 1);
    // ㄹ 받침(일·칠·팔 포함)은 '로'
    if ((code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8) || '178'.includes(last) || last.toLowerCase() === 'l') return word + '로';
  }
  return word + (hasBatchim(word) ? withB : withoutB);
}
