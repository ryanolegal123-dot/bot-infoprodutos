import { html, money, uuid, isUuid, validCpf, paymentMatches } from './security.js';

export function createBot(api,config,collectorId) {
  const {db,telegram,mp}=api;
  const active = new Map();
  const message = (chat,text,extra={}) => telegram('sendMessage',{chat_id:chat,text,parse_mode:'HTML',...extra});
  const one = async (table,q) => (await db(table,q+'&limit=1'))[0];
  const product = id => one('produtos',`id=eq.${id}`);
  const customer = async m => (await db('clientes','on_conflict=telegram_user_id','POST',{
    telegram_user_id:m.from.id,telegram_chat_id:m.chat.id,username:m.from.username ?? null,nome:m.from.first_name ?? null
  },'resolution=merge-duplicates,return=representation'))[0];
  async function catalog(chat) {
    const products=await db('produtos','ativo=eq.true&telegram_file_id=not.is.null&order=criado_em.asc&limit=50');
    if (!products.length) return message(chat,'Ainda não há produtos disponíveis.');
    for (const p of products) await message(chat,`📚 <b>${html(p.nome)}</b>\n${html(p.descricao).slice(0,2500)}\n\n${money(p.preco)}`,{
      reply_markup:{inline_keyboard:[[{text:'Comprar com Pix',callback_data:`buy:${p.id}`}]]}
    });
  }
  async function pix(order,client) {
    if (!order.mp_payment_id) {
      // Reuse precisely the same request and idempotency key after a timeout/restart.
      const payer=order.payer_snapshot;
      const p=await mp('/v1/payments','POST',{
        transaction_amount:Number(order.valor),description:order.produto_nome_snapshot,
        payment_method_id:'pix',payer,external_reference:order.id,
        notification_url:`${config.PUBLIC_BASE_URL}/webhooks/mercadopago`,
        date_of_expiration:new Date(Date.parse(order.criado_em)+30*60*1000).toISOString()
      },order.id);
      const tx=p.point_of_interaction?.transaction_data;
      if (!p.id || !tx?.qr_code) throw new Error('Resposta Pix inválida');
      order=(await db('pedidos',`id=eq.${order.id}`,'PATCH',{
        mp_payment_id:String(p.id),mp_status:p.status,pix_copia_cola:tx.qr_code,pix_qr_code_base64:tx.qr_code_base64 || null
      }))[0];
    }
    if(order.status==='pago') return checkPayment(order.mp_payment_id);
    if(order.pix_qr_code_base64) {
      const form=new FormData();form.set('chat_id',String(client.telegram_chat_id));
      form.set('caption',`Pix de ${money(order.valor)} — ${order.produto_nome_snapshot}\nValidade: 30 minutos a partir da criação.`);
      form.set('photo',new Blob([Buffer.from(order.pix_qr_code_base64,'base64')],{type:'image/png'}),'pix.png');
      await telegram('sendPhoto',form);
    }
    await message(client.telegram_chat_id,`Pix copia e cola:\n<code>${html(order.pix_copia_cola)}</code>\n\nO PDF será enviado após a confirmação.`,{
      reply_markup:{inline_keyboard:[[{text:'Verificar pagamento',callback_data:`check:${order.id}`}]]}
    });
  }
  async function buy(id,client,updateId) {
    const p=await product(id);
    if(!p?.ativo || !p.telegram_file_id) return message(client.telegram_chat_id,'Produto indisponível. Use /start.');
    if(!client.email || !validCpf(client.cpf)) return message(client.telegram_chat_id,
      'Para gerar o Pix, envie seu e-mail e CPF no formato:\n<code>/dados seu@email.com 00000000000</code>\n\nUsaremos esses dados para a cobrança no Mercado Pago. Depois, toque em Comprar novamente. Use /suporte para dúvidas.');
    // Resume an existing unexpired Pix for this customer/product.
    let order=await one('pedidos',`cliente_id=eq.${client.id}&produto_id=eq.${id}&status=eq.pendente&criado_em=gt.${new Date(Date.now()-29*60*1000).toISOString()}&order=criado_em.desc`);
    if(!order) {
      const orderId=uuid(`telegram-buy:${updateId}`);
      order=await one('pedidos',`id=eq.${orderId}`);
      if(!order) order=(await db('pedidos','','POST',{
        id:orderId,cliente_id:client.id,produto_id:id,valor:p.preco,
        telegram_file_id_snapshot:p.telegram_file_id,produto_nome_snapshot:p.nome,
        payer_snapshot:{email:client.email,identification:{type:'CPF',number:client.cpf}}
      }))[0];
    }
    await pix(order,client);
  }
  async function deliver(order) {
    if(order.entregue_em || !order.telegram_file_id_snapshot) return;
    const now=new Date().toISOString(),cutoff=new Date(Date.now()-5*60*1000).toISOString();
    const claimed=await db('pedidos',`id=eq.${order.id}&status=eq.pago&entregue_em=is.null&or=(delivery_claimed_at.is.null,delivery_claimed_at.lt.${cutoff})`,'PATCH',{delivery_claimed_at:now});
    if(!claimed.length) return;
    const client=await one('clientes',`id=eq.${order.cliente_id}`);
    // At-least-once delivery: uncertain Telegram network responses can cause a repeat.
    await telegram('sendDocument',{chat_id:client.telegram_chat_id,document:order.telegram_file_id_snapshot,
      caption:`✅ Pagamento confirmado! Aqui está ${order.produto_nome_snapshot}.`});
    await db('pedidos',`id=eq.${order.id}`,'PATCH',{entregue_em:new Date().toISOString(),delivery_claimed_at:null,payer_snapshot:null});
  }
  async function checkPayment(id) {
    if(!/^\d+$/.test(String(id))) return;
    if(active.has(id)) return active.get(id);
    const run=(async()=>{
      let order=await one('pedidos',`mp_payment_id=eq.${id}`);
      if(!order) return;
      const p=await mp(`/v1/payments/${id}`);
      if(!paymentMatches(p,order,collectorId)) throw new Error('Pagamento não corresponde ao pedido');
      const statuses={approved:'pago',cancelled:'cancelado',rejected:'cancelado',refunded:'reembolsado',charged_back:'reembolsado',pending:'pendente',in_process:'pendente'};
      const patch={mp_status:p.status,atualizado_em:new Date().toISOString()};
      if(statuses[p.status]) patch.status=statuses[p.status];
      if(p.status==='approved') patch.pago_em=p.date_approved || new Date().toISOString();
      order=(await db('pedidos',`id=eq.${order.id}`,'PATCH',patch))[0];
      if(p.status==='approved') await deliver(order);
      return order;
    })();
    active.set(id,run);
    try { return await run; } finally { active.delete(id); }
  }
  async function handle(update) {
    const cb=update.callback_query;
    const m=update.message ?? (cb?.message ? {...cb.message,from:cb.from} : null);
    if(!m?.from || m.chat?.type!=='private') return;
    if(cb) await telegram('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    const client=await customer(m),chat=m.chat.id;
    const admin=String(m.from.id)===config.ADMIN_TELEGRAM_ID;
    const text=m.text ?? '',command=text.split(/[\s@]/)[0];
    if(cb) {
      const [action,id]=cb.data?.split(':') ?? [];
      if(!isUuid(id ?? '')) return;
      if(action==='buy') return buy(id,client,update.update_id);
      if(action==='check') {
        const order=await one('pedidos',`id=eq.${id}&cliente_id=eq.${client.id}`);
        if(!order?.mp_payment_id) return message(chat,'Cobrança ainda não disponível. Toque em Comprar novamente.');
        const checked=await checkPayment(order.mp_payment_id);
        return message(chat,checked?.status==='pago' ? '✅ Pagamento confirmado.' : 'Pagamento ainda não aprovado. A confirmação é automática.');
      }
      return;
    }
    if(command==='/id') return message(chat,`Seu ID: <code>${m.from.id}</code>`);
    if(command==='/start' || command==='/produtos') return catalog(chat);
    if(command==='/suporte' || command==='/paysupport') return message(chat,html(config.SUPPORT_TEXT));
    if(command==='/dados') {
      const [,email,rawCpf]=text.trim().split(/\s+/);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '') || email.length>254 || !validCpf(rawCpf ?? '')) return message(chat,'E-mail ou CPF inválido. Use /dados seu@email.com SEU_CPF.');
      await db('clientes',`id=eq.${client.id}`,'PATCH',{email,cpf:rawCpf.replace(/\D/g,'')});
      // Reduce exposure in chat; deletion is best effort, not a guarantee of erasure.
      await telegram('deleteMessage',{chat_id:chat,message_id:m.message_id}).catch(()=>{});
      return message(chat,'Dados salvos. Agora toque em Comprar no produto.');
    }
    if(command==='/compras') {
      const orders=await db('pedidos',`cliente_id=eq.${client.id}&status=eq.pago&order=criado_em.desc&limit=20`);
      if(!orders.length) return message(chat,'Nenhuma compra aprovada encontrada.');
      for(const o of orders) {
        const verified=await checkPayment(o.mp_payment_id);
        if(verified?.status==='pago') await telegram('sendDocument',{chat_id:chat,document:o.telegram_file_id_snapshot,caption:o.produto_nome_snapshot});
      }
      return;
    }
    if(command==='/admin') return message(chat,admin ? '⚙️ Administração\n\nEnvie um PDF com a legenda:\n<code>/produto Nome | 19,90 | Descrição</code>\n\n/vendas — últimas vendas\n/desativar ID — retirar produto do catálogo\n/ativar ID — publicar novamente' : 'Acesso restrito.');
    if(admin && m.document && m.caption?.startsWith('/produto ')) {
      if(!/\.pdf$/i.test(m.document.file_name ?? '')) return message(chat,'Envie um arquivo .pdf.');
      const [name,rawPrice,...desc]=m.caption.slice(9).split('|').map(x=>x.trim());
      const price=Number(rawPrice?.replace(',','.'));
      if(!name || name.length>150 || !/^\d+(?:[.,]\d{1,2})?$/.test(rawPrice ?? '') || price<=0 || price>100000) return message(chat,'Use /produto Nome | 19,90 | Descrição na legenda do PDF.');
      const id=uuid(`telegram-product:${update.update_id}`);
      await db('produtos','on_conflict=id','POST',{id,nome:name,preco:price,descricao:desc.join(' | '),telegram_file_id:m.document.file_id,arquivo_nome:m.document.file_name},'resolution=ignore-duplicates,return=representation');
      return message(chat,`Produto cadastrado! ID: <code>${id}</code>`);
    }
    if(admin && ['/ativar','/desativar'].includes(command)) {
      const id=text.trim().split(/\s+/)[1];
      if(!isUuid(id ?? '')) return message(chat,'Informe o ID do produto.');
      const result=await db('produtos',`id=eq.${id}`,'PATCH',{ativo:command==='/ativar'});
      return message(chat,result.length ? 'Produto atualizado.' : 'Produto não encontrado.');
    }
    if(admin && command==='/vendas') {
      const rows=await db('pedidos','status=eq.pago&order=pago_em.desc&limit=20');
      return message(chat,rows.length ? rows.map(o=>`${html(o.produto_nome_snapshot)} — ${money(o.valor)}\n${html(o.id)}`).join('\n\n') : 'Nenhuma venda aprovada.');
    }
    return message(chat,'Use /start para ver os produtos, /compras para receber seus PDFs ou /suporte.');
  }
  async function reconcile() {
    const rows=await db('pedidos','mp_payment_id=not.is.null&or=(status.eq.pendente,and(status.eq.pago,entregue_em.is.null))&order=atualizado_em.asc&limit=100');
    for(const o of rows) {
      try { await checkPayment(o.mp_payment_id); } catch { console.error('Falha ao reconciliar pedido',o.id); }
    }
  }
  return {handle,checkPayment,reconcile,message};
}
