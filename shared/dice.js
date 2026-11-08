export function mixSeed(seed, index) {
  let x = (seed ^ Math.imul(index + 1, 0x9E3779B1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85EBCA6B) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xC2B2AE35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function parseExpression(input) {
  const source = input.replace(/\s+/g, '').toLowerCase();
  if (!source) throw new Error('Enter a dice expression.');

  const terms = [];
  let index = 0;
  let expectTerm = true;
  let pendingSign = 1;

  if (source[0] === '+' || source[0] === '-') {
    if (source[0] === '-') pendingSign = -1;
    index = 1;
  }

  while (index < source.length) {
    if (!expectTerm) {
      const operator = source[index];
      if (operator !== '+' && operator !== '-') {
        throw new Error(`Expected + or - at position ${index + 1}.`);
      }
      pendingSign = operator === '-' ? -1 : 1;
      index++;
    }

    const start = index;
    while (index < source.length && /\d/.test(source[index])) index++;
    const numberText = source.slice(start, index);

    if (source[index] === 'd') {
      const count = numberText ? Number(numberText) : 1;
      index++;

      const sidesStart = index;
      while (index < source.length && /\d/.test(source[index])) index++;
      const sidesText = source.slice(sidesStart, index);

      if (!sidesText) {
        throw new Error(`Missing die size near position ${sidesStart + 1}.`);
      }

      const sides = Number(sidesText);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error('Dice count must be a positive integer.');
      }
      if (!Number.isInteger(sides) || sides < 1) {
        throw new Error('Die size must be a positive integer.');
      }

      let keepCount = count;
      let keepMode = 'all';

      if (source[index] === 'a' || source[index] === 'd') {
        keepMode = source[index] === 'a' ? 'highest' : 'lowest';
        index++;

        const keepStart = index;
        while (index < source.length && /\d/.test(source[index])) index++;
        const keepText = source.slice(keepStart, index);

        if (!keepText) {
          throw new Error(`Missing keep count after ${keepMode === 'highest' ? 'a' : 'd'} near position ${keepStart + 1}.`);
        }

        keepCount = Number(keepText);
        if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > count) {
          throw new Error(`Keep count must be between 1 and ${count}.`);
        }
      }

      terms.push({
        type: 'dice',
        count,
        sides,
        sign: pendingSign,
        keepCount,
        keepMode
      });
    } else {
      if (!numberText) {
        throw new Error(`Expected a number or die term at position ${start + 1}.`);
      }

      terms.push({
        type: 'constant',
        value: Number(numberText),
        sign: pendingSign
      });
    }

    expectTerm = false;
  }

  if (expectTerm) throw new Error('Expression ends with an operator.');
  return terms;
}

export function expandDiceTerms(terms, rollId, rollSeed) {
  const dice = [];
  let constantTotal = 0;
  let dieIndex = 0;

  for (const term of terms) {
    if (term.type === 'constant') {
      constantTotal += term.sign * term.value;
      continue;
    }

    const termIndex = dice.length + 1;
    if (![4, 6, 8, 10, 12, 20].includes(term.sides)) {
      throw new Error(`Unsupported die: d${term.sides}. Available dice are d4, d6, d8, d10, d12, and d20.`);
    }

    for (let i = 0; i < term.count; i++) {
      const index = dieIndex++;
      dice.push({
        id: `${rollId}-die-${String(index + 1).padStart(3, '0')}`,
        index,
        dieType: `d${term.sides}`,
        sides: term.sides,
        sign: term.sign,
        keepCount: term.keepCount,
        keepMode: term.keepMode ?? 'all',
        termIndex,
        seed: mixSeed(rollSeed, index)
      });
    }
  }

  return { dice, constantTotal };
}

export function formatTerms(terms) {
  return terms.map((term, i) => {
    const prefix = i === 0
      ? (term.sign < 0 ? '-' : '')
      : (term.sign < 0 ? ' - ' : ' + ');

    if (term.type === 'constant') return `${prefix}${term.value}`;

    const keepText = term.keepCount < term.count
      ? `${term.keepMode === 'lowest' ? 'd' : 'a'}${term.keepCount}`
      : '';
    const diceText = `${term.count === 1 ? '' : term.count}d${term.sides}${keepText}`;
    return `${prefix}${diceText}`;
  }).join('');
}
