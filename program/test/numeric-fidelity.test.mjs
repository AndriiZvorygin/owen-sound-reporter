import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNumericFidelity, hasNumericFidelity, numericFidelityDefects } from '../shared/numeric-fidelity.mjs';

test('accepts conventional civic numeric notation', () => {
  const text = 'The proposal at 1201 15th Avenue East contains 128 rental units and may affect $985,000 in development charges by 2051.';
  assert.equal(hasNumericFidelity(text), true);
  assert.deepEqual(numericFidelityDefects(text), []);
});

test('rejects digit-by-digit number words and spelled street ordinals', () => {
  const text = 'The proposal at one-two-zero-one Fifteenth Avenue East contains twelve-eight rental units.';
  assert.equal(hasNumericFidelity(text), false);
  assert.throws(() => assertNumericFidelity(text, 'test summary'), /one-two-zero-one.*twelve-eight.*Fifteenth Avenue/u);
});

test('allows ordinary natural-language quantities', () => {
  assert.equal(hasNumericFidelity('The southern six hectares may support forty to sixty jobs.'), true);
  assert.equal(hasNumericFidelity('The programme uses a fifty-fifty funding formula.'), true);
});
