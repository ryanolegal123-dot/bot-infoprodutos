-- Complemento do banco existente bot-infoprodutos. Executar uma vez.
begin;
alter table public.clientes add column if not exists email text;
alter table public.clientes add column if not exists cpf text;
alter table public.pedidos add column if not exists payer_snapshot jsonb;
alter table public.pedidos add column if not exists telegram_file_id_snapshot text;
alter table public.pedidos add column if not exists produto_nome_snapshot text;
alter table public.pedidos add column if not exists delivery_claimed_at timestamptz;
create table if not exists public.bot_runtime (id integer primary key check(id=1), telegram_offset bigint not null default 0);
alter table public.bot_runtime enable row level security;
revoke all on public.bot_runtime from anon, authenticated;
grant all on public.bot_runtime,public.clientes,public.produtos,public.pedidos to service_role;
insert into public.bot_runtime(id) values (1) on conflict do nothing;
commit;
