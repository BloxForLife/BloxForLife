// Hate-slur filter for user-submitted text. Deliberately narrow: this blocks
// slurs aimed at groups (race, ethnicity, sexuality, disability), NOT general
// profanity — "fuck", "bitch", "mf" etc. are fine here.
//
// Text is normalized first (diacritics stripped, lowercased, common leetspeak
// mapped back: n1gg3r -> nigger) and then checked two ways:
//   1. word-level, with punctuation turned into spaces ("f@g.g0t" -> "faggot")
//   2. fully joined, with ALL non-letters removed ("n i g g e r" -> "nigger"),
//      using only patterns that can't collide with ordinary words.

const LEET = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't' };

function normalize(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')          // diacritics
        .replace(/[​-‏⁠﻿]/g, '') // zero-width chars
        .toLowerCase()
        .replace(/[0134578@$!]/g, (c) => LEET[c]);
}

// Checked against text where punctuation became spaces, so \b is meaningful.
// The gg in the n-word is required so Niger / Nigeria never match.
const WORD_PATTERNS = [
    /\bnig{2,}(?:er|a)[sz]?\b/,
    /\bfag{1,2}(?:ot)?s?\b/,
    /\bkikes?\b/,
    /\btrann(?:y|ies)\b/,
    /\bchinks?\b/,
    /\bgooks?\b/,
    /\bspics?\b/,
    /\bwetbacks?\b/,
    /\bbeaners?\b/,
    /\bcoons?\b/,
    /\bdykes?\b/,
    /\bpakis?\b/,
    /\bretard(?:ed|s)?\b/,
    /\btowelheads?\b/,
    /\bragheads?\b/,
    /\bjigaboos?\b/,
    /\bporch ?monkeys?\b/
];

// Checked against text with every non-letter removed (catches s p a c e d
// out and dotted evasion). Only patterns long/specific enough not to appear
// inside normal phrases — "spic" is left out because of "spicy", "wetback"
// because "wet back pain" would join into it.
const JOINED_PATTERNS = [
    /nig{2,}(?:er|a)/,
    /fag{1,2}ot/,
    /trann(?:y|ie)/,
    /towelhead/,
    /raghead/,
    /jigaboo/,
    /porchmonkey/
];

export function containsSlur(text) {
    const norm = normalize(text);
    const spaced = norm.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ');
    if (WORD_PATTERNS.some((p) => p.test(spaced))) return true;
    const joined = norm.replace(/[^a-z]/g, '');
    return JOINED_PATTERNS.some((p) => p.test(joined));
}
