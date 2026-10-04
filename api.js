export class ApiError extends Error { constructor(service,status,code) { super(`${service}: HTTP ${status} (${code ?? 'erro'})`); this.status=status; } }
export async function jsonRequest(service,url,options={}) {
  const response = await fetch(url,{...options,signal:AbortSignal.timeout(service==='Telegram' ? 45000 : 20000)});
  const data = await response.json().catch(()=>null);
  if (!response.ok || data?.ok===false) throw new ApiError(service,response.status,data?.code ?? data?.error_code);
  return data;
}
export function createApis(config) {
  const db = (table,query='',method='GET',body,prefer='return=representation') => jsonRequest('Supabase',`${config.SUPABASE_URL}/rest/v1/${table}${query ? '?'+query : ''}`,{
    method,headers:{apikey:config.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined ? undefined : JSON.stringify(body)
  });
  const telegram = (method,body) => jsonRequest('Telegram',`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`,{
    method:'POST',headers:body instanceof FormData ? undefined : {'Content-Type':'application/json'},body:body instanceof FormData ? body : JSON.stringify(body)
  }).then(r=>r.result);
  const mp = (path,method='GET',body,key) => jsonRequest('Mercado Pago',`https://api.mercadopago.com${path}`,{
    method,headers:{Authorization:`Bearer ${config.MERCADOPAGO_ACCESS_TOKEN}`,'Content-Type':'application/json',...(key ? {'X-Idempotency-Key':key} : {})},body:body===undefined ? undefined : JSON.stringify(body)
  });
  return {db,telegram,mp};
}
