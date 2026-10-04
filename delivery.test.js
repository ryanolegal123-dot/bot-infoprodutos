import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
function fixture(status='approved',amount=19.9) {
  const order={id:'test-order',mp_payment_id:'123',valor:19.9,status:'pendente',cliente_id:'customer',telegram_file_id_snapshot:'telegram-pdf-id',produto_nome_snapshot:'Ebook',entregue_em:null};
  const calls=[];
  const api={
    db:async(table,query,method,body)=>{
      if(table==='clientes') return [{id:'customer',telegram_chat_id:42}];
      if(method==='PATCH') {
        if(query.includes('entregue_em=is.null') && (order.entregue_em || order.delivery_claimed_at)) return [];
        Object.assign(order,body);return [{...order}];
      }
      return [{...order}];
    },
    mp:async()=>({id:123,external_reference:'test-order',collector_id:99,currency_id:'BRL',payment_method_id:'pix',live_mode:true,transaction_amount:amount,status}),
    telegram:async(method,body)=>{calls.push({method,body});return {message_id:1};}
  };
  return {bot:createBot(api,{ADMIN_TELEGRAM_ID:'1'},99),order,calls};
}
test('pending payment never delivers the PDF',async()=>{
  const f=fixture('pending');await f.bot.checkPayment('123');assert.equal(f.calls.length,0);assert.equal(f.order.status,'pendente');
});
test('concurrent and repeated approved notifications send one PDF',async()=>{
  const f=fixture();await Promise.all([f.bot.checkPayment('123'),f.bot.checkPayment('123')]);await f.bot.checkPayment('123');
  assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,1);assert.equal(f.order.status,'pago');assert.ok(f.order.entregue_em);
});
test('wrong paid amount cannot release PDF or mark order paid',async()=>{
  const f=fixture('approved',1);await assert.rejects(f.bot.checkPayment('123'));
  assert.equal(f.calls.length,0);assert.equal(f.order.status,'pendente');
});
