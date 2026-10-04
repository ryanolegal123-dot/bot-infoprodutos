# Bot de infoprodutos: Telegram + Pix + PDF

V1 em Node.js 22, sem dependências externas. Banco: projeto Supabase `bot-infoprodutos`.

## Fluxo

`/start` → catálogo → Comprar → dados reais do pagador, se ainda não cadastrados → QR Code e copia e cola no chat → aprovação consultada no Mercado Pago → PDF enviado como documento.

O Telegram exige Stars para vendas de produtos digitais dentro de bots. O fluxo Pix deste projeto é tecnicamente implementado, mas não atende a essa regra da plataforma. Referência: https://core.telegram.org/bots/payments-stars

## Configuração no Render

1. Coloque todos os arquivos deste projeto na raiz do repositório, mantendo `src/` e `test/` como pastas. Nunca envie `.env` ou tokens ao GitHub.
2. O complemento `schema-upgrade.sql` deve estar aplicado no projeto Supabase antes de iniciar o serviço.
3. No Render: **New → Web Service**, conecte `ryanolegal123-dot/bot-infoprodutos`, selecione a branch `main` e runtime Node.
4. Build command: `npm ci`. Start command: `npm start`. Health check: `/health`. Use apenas **uma instância**, sem outro serviço executando o mesmo token Telegram.
5. Configure as variáveis de `.env.example` no painel Environment. Use a chave backend `service_role` do projeto correto, nunca a chave `anon`. A aplicação usa REST diretamente.
6. `PUBLIC_BASE_URL` é a URL HTTPS atribuída pelo Render, sem barra final.
7. No Mercado Pago Developers → sua aplicação → Webhooks, configure a URL `https://SEU-SERVICO.onrender.com/webhooks/mercadopago`, ambiente de produção e eventos **Pagamentos**. Copie a assinatura secreta para `MERCADOPAGO_WEBHOOK_SECRET` no Render. Esta assinatura é diferente do Access Token.
8. Configure `ADMIN_TELEGRAM_ID` com o seu ID numérico. Você pode obtê-lo com um bot de identificação ou no seu bot pelo comando `/id` após iniciado; até ajustar para o seu ID, o painel fica restrito ao ID configurado.
9. Defina `SUPPORT_TEXT` com o contato real para suporte e reembolso.
10. Faça o deploy. Se mudar uma variável, reinicie/reimplante o serviço.

**Disponibilidade:** um serviço que dorme após inatividade não garante confirmação/entrega imediatas. Para atendimento contínuo, escolha hospedagem que permaneça ativa. Confira os preços e condições atuais no Render antes de contratar: https://render.com/docs/free

## Cadastrar o primeiro produto

No chat privado do seu bot, envie `/admin`. Envie o PDF como **documento**, com esta legenda:

```
/produto Desejo Fit | 19,90 | 200 receitas fitness para o dia a dia.
```

O bot guarda o `file_id` do próprio Telegram, sem tornar o PDF público. Esses IDs pertencem ao bot que recebeu o arquivo: se trocar de bot/token, envie os PDFs novamente. O comando retorna o ID do produto.

Comandos:

| Comando | Função |
| --- | --- |
| `/start` ou `/produtos` | Catálogo |
| `/dados email CPF` | Dados do pagador para a cobrança |
| `/compras` | Receber novamente PDFs de compras aprovadas |
| `/suporte` ou `/paysupport` | Contato do vendedor |
| `/id` | ID numérico do usuário |
| `/admin` | Ajuda administrativa, somente proprietário |
| `/vendas` | Últimas 20 vendas aprovadas, somente proprietário |
| `/desativar ID` ou `/ativar ID` | Alterar disponibilidade, somente proprietário |

O cadastro pede e-mail e CPF reais conforme a documentação consultada do Mercado Pago. O bot tenta apagar a mensagem `/dados` do chat após salvar; isso não garante remoção de todas as cópias. Não há CPF fictício nem uso do e-mail do vendedor como pagador. O banco mantém os dados com RLS, para acesso exclusivo do backend; proteja também o acesso administrativo ao Supabase.

## Teste antes de divulgar

1. Execute `npm test`.
2. Cadastre um PDF de teste, com preço baixo permitido pelo Mercado Pago.
3. Com outra conta Telegram, abra `/start`, escolha o produto, envie `/dados` e toque novamente em Comprar.
4. Confira a imagem do QR Code e o copia e cola no próprio chat.
5. Pague usando uma conta de comprador diferente da conta recebedora.
6. Confira o pagamento aprovado no Mercado Pago, o pedido pago no Supabase e o PDF recebido. Sem pagamento, o PDF não pode ser liberado.
7. Clique novamente em Verificar pagamento: não deve repetir a entrega automática. `/compras` permite reenvio solicitado pelo comprador.

Nenhuma venda real foi testada durante a preparação: faltam credenciais, implantação e um pagamento real feito pelo usuário.

## Segurança e limites da V1

- Valor e PDF são copiados para o pedido a partir do banco, nunca de dados enviados pelo comprador.
- Cobranças usam o UUID do pedido como chave de idempotência, inclusive em tentativas após timeout.
- O webhook valida HMAC SHA-256 e consulta o pagamento na API autenticada. Confere ID, referência, valor, moeda, Pix, produção e conta recebedora antes de liberar o PDF.
- Há reconciliação periódica e bloqueio de entrega concorrente por pedido. Em falhas incertas de rede ou queda entre envio e registro, pode ocorrer reenvio: a entrega é feita com tentativas, sem garantia matemática de exatamente uma vez.
- A conciliação reconsulta até 100 pedidos por ciclo, priorizando os verificados há mais tempo. O atraso aumenta conforme o volume.
- QR Codes expiram em 30 minutos. Um Pix pendente recente é reutilizado para o mesmo cliente/produto. O botão não libera nada apenas por o comprador declarar que pagou.
- Só mensagens privadas são atendidas. Admin é validado pelo ID de quem envia a mensagem.
- Não inclui cupons, disparos, order bump, painel web ou reembolso automático. Reembolso deve ser processado no Mercado Pago pelo vendedor. Arquivos já entregues não podem ser revogados.
- Se o cliente bloquear o bot, a entrega não será possível enquanto o bloqueio persistir. Há tentativas posteriores.
- O poller preserva seu offset no banco. Rode apenas uma instância e evite sobreposição durante deploys. Em falhas repetidas de uma atualização, o usuário recebe orientação para tentar de novo; pedidos já vinculados ao Mercado Pago continuam na conciliação.

Documentação consultada:

- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix
- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/optional-notifications
- https://core.telegram.org/bots/api
- https://supabase.com/docs/guides/api/securing-your-api

## Desenvolvimento local

Copie `.env.example` para `.env`, preencha os segredos localmente e execute:

```
npm ci
npm test
node --env-file=.env server.js
```

O webhook exige uma URL HTTPS pública; localhost sozinho não recebe notificações do Mercado Pago.
