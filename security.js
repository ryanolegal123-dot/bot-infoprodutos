import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money = value => new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'}).format(Number(value));
export const uuid = value => { const h = createHash('sha256').update(String(value)).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export const isUuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function validCpf(raw) {
  const c = String(raw).replace(/\D/g,'');
  if (!/^\d{11}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
  for (let n=9; n<11; n++) { let s=0; for (let i=0;i<n;i++) s+=Number(c[i])*(n+1-i); if (((s*10)%11)%10 !== Number(c[n])) return false; }
  return true;
}
export function verifySignature(id, headers, secret) {
  const values = Object.fromEntries(String(headers['x-signature'] ?? '').split(',').map(x => x.trim().split('=')));
  const requestId = headers['x-request-id'];
  if (!/^\d+$/.test(String(id)) || !requestId || !/^\d+$/.test(values.ts ?? '') || !/^[a-f0-9]{64}$/i.test(values.v1 ?? '')) return false;
  const manifest = `id:${String(id).toLowerCase()};request-id:${requestId};ts:${values.ts};`;
  const expected = createHmac('sha256',secret).update(manifest).digest();
  return timingSafeEqual(expected,Buffer.from(values.v1,'hex'));
}
export function paymentMatches(p, order, collectorId, live=true) {
  return String(p.id) === String(order.mp_payment_id) && p.external_reference === order.id &&
    String(p.collector_id) === String(collectorId) && p.currency_id === 'BRL' && p.payment_method_id === 'pix' &&
    p.live_mode === live && Math.round(Number(p.transaction_amount)*100) === Math.round(Number(order.valor)*100);
}
