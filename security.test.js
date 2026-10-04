import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature,paymentMatches,html,validCpf,uuid,isUuid } from '../src/security.js';
test('webhook authenticates signed query id and rejects tampering',()=>{
  const ts='1700000000000',secret='test-only',req='abc';
  const sig=createHmac('sha256',secret).update(`id:123;request-id:${req};ts:${ts};`).digest('hex');
  const headers={'x-signature':`ts=${ts},v1=${sig}`,'x-request-id':req};
  assert.equal(verifySignature('123',headers,secret),true);
  assert.equal(verifySignature('124',headers,secret),false);
  assert.equal(verifySignature('123',headers,'wrong'),false);
  assert.equal(verifySignature('123',{},secret),false);
  assert.equal(verifySignature('123',{...headers,'x-signature':'ts=1,v1=xx'},secret),false);
});
test('approval must match amount, account, currency, mode and order',()=>{
  const order={id:'order',mp_payment_id:'123',valor:'19.90'};
  const p={id:123,external_reference:'order',collector_id:42,currency_id:'BRL',payment_method_id:'pix',live_mode:true,transaction_amount:19.9};
  assert.equal(paymentMatches(p,order,42),true);
  for(const override of [{transaction_amount:1},{collector_id:1},{external_reference:'other'},{live_mode:false},{currency_id:'USD'},{payment_method_id:'visa'},{id:124}]) assert.equal(paymentMatches({...p,...override},order,42),false);
});
test('CPF validation, HTML escaping and deterministic order identifiers',()=>{
  assert.equal(validCpf('11111111111'),false);assert.equal(validCpf('12345678900'),false);
  assert.equal(validCpf('529.982.247-25'),true);
  assert.equal(html('<a>&'), '&lt;a&gt;&amp;');
  assert.equal(uuid('same'),uuid('same'));assert.notEqual(uuid('same'),uuid('other'));assert.equal(isUuid(uuid('same')),true);
});
