import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApis } from './scr/api.js';
import { createBot } from './scr/bot.js';
import { verifySignature } from './scr/security.js';

const required=['TELEGRAM_BOT_TOKEN','MERCADOPAGO_ACCESS_TOKEN','MERCADOPAGO_WEBHOOK_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','ADMIN_TELEGRAM_ID','PUBLIC_BASE_URL'];
for(const name of required) if(!process.env[name]) { console.error(`Configure ${name}`); process.exit(1); }
const config={...process.env,SUPPORT_TEXT:process.env.SUPPORT_TEXT || 'Fale com o vendedor para suporte e reembolso.'};
config.PUBLIC_BASE_URL=config.PUBLIC_BASE_URL.replace(/\/$/,'');
config.SUPABASE_URL=config.SUPABASE_URL.replace(/\/$/,'');
if(!/^\d+$/.test(config.ADMIN_TELEGRAM_ID) || !config.PUBLIC_BASE_URL.startsWith('https://') || !config.SUPABASE_URL.startsWith('https://')) throw new Error('Configuração inválida');
const api=createApis(config);
const me=await api.mp('/users/me');
if(!me.id) throw new Error('Conta Mercado Pago inválida');
const bot=createBot(api,config,me.id);
await api.telegram('getMe',{});
const state=await api.db('bot_runtime','id=eq.1');
if(!state[0]) throw new Error('Aplique schema-upgrade.sql antes de iniciar.');
let offset=Number(state[0].telegram_offset),stopping=false,lastPoll=Date.now();

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET' && url.pathname==='/health') {
      res.writeHead(Date.now()-lastPoll<180000 ? 200 : 503,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:Date.now()-lastPoll<180000}));
    }
    if(req.method!=='POST' || url.pathname!=='/webhooks/mercadopago') { res.writeHead(404); return res.end(); }
    let size=0,chunks=[];
    for await(const chunk of req) { size+=chunk.length;if(size>65536) {res.writeHead(413);return res.end();} chunks.push(chunk); }
    let body;try {body=JSON.parse(Buffer.concat(chunks).toString());} catch {res.writeHead(400);return res.end();}
    const id=url.searchParams.get('data.id');
    if(!verifySignature(id,req.headers,config.MERCADOPAGO_WEBHOOK_SECRET)) {res.writeHead(401);return res.end();}
    if(body.data?.id !== undefined && String(body.data.id)!==id) {res.writeHead(400);return res.end();}
    if((body.type ?? url.searchParams.get('type'))!=='payment') {res.writeHead(200);return res.end();}
    // Respond only after verification/delivery succeeds; failures receive retries.
    await bot.checkPayment(id);
    res.writeHead(200);res.end('ok');
  } catch { console.error('Falha no webhook; aguardando nova tentativa.');if(!res.headersSent) res.writeHead(500);res.end(); }
});
server.requestTimeout=60000;
server.listen(Number(config.PORT || 3000),'0.0.0.0',()=>console.log('Servidor iniciado'));

// One running instance only. Do not combine this poller with another bot service.
await api.telegram('deleteWebhook',{drop_pending_updates:false});
async function poll() {
  while(!stopping) {
    try {
      const updates=await api.telegram('getUpdates',{offset,timeout:20,limit:20,allowed_updates:['message','callback_query']});
      lastPoll=Date.now();
      for(const update of updates) {
        let handled=false;
        for(let attempt=0;attempt<3 && !handled;attempt++) {
          try { await bot.handle(update);handled=true; } catch {
            console.error('Falha ao processar atualização',update.update_id);
            if(attempt<2) await sleep(2000);
          }
        }
        if(!handled) {
          const chat=update.message?.chat ?? update.callback_query?.message?.chat;
          if(chat?.type==='private') await bot.message(chat.id,'Não consegui concluir agora. Aguarde um minuto e tente novamente. Se o Pix já foi pago, a entrega será tentada automaticamente.').catch(()=>{});
        }
        // Deterministic IDs/idempotency preserve financial operations across replays.
        const next=update.update_id+1;
        await api.db('bot_runtime','id=eq.1','PATCH',{telegram_offset:next});offset=next;
      }
    } catch { console.error('Falha na conexão do bot; tentando novamente.');await sleep(5000); }
  }
}
async function reconciliationLoop() {
  while(!stopping) {
    try { await bot.reconcile(); } catch {console.error('Falha na conciliação automática.');}
    await sleep(60000);
  }
}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stopping=true;server.close();setTimeout(()=>process.exit(0),1000).unref();});
await Promise.all([poll(),reconciliationLoop()]);
