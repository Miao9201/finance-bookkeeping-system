import test from 'node:test';
import assert from 'node:assert/strict';
import {cents,yuan} from '../src/api.js';
test('money converts decimal strings exactly and rejects excess precision', () => {
  assert.equal(cents('0.29'),29);
  assert.equal(cents('123456.78'),12345678);
  assert.throws(()=>cents('1.001'));
  assert.throws(()=>cents('-1'));
  assert.throws(()=>cents('Infinity'));
  assert.throws(()=>cents('9007199254740991'));
});
test('maximum safe integer cents survives display and edit without losing a cent',()=>{
  assert.equal(yuan(Number.MAX_SAFE_INTEGER),'90,071,992,547,409.91');
  assert.equal(cents(yuan(Number.MAX_SAFE_INTEGER).replaceAll(',','')),Number.MAX_SAFE_INTEGER);
});
