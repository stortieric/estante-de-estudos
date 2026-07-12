-- ============================================================
-- ESTANTE DE ESTUDOS — schema (rodar 1x no SQL Editor do Supabase)
-- ============================================================

-- Conteúdo (leitura para usuários logados; escrita só via dashboard/SQL editor)
create table public.cursos (
  id text primary key,
  ordem int not null default 0,
  nome text not null,
  sub text,
  etiqueta text,
  cor text not null,
  cor_suave text not null,
  curriculo jsonb not null   -- etapas → disciplinas (inclusive as pendentes)
);

create table public.modulos (
  id text primary key,
  curso_id text not null references public.cursos(id) on delete cascade,
  dados jsonb not null,      -- { descricao, livros[], aulas[] } no formato do app
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Progresso individual (repetição espaçada)
create table public.attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,         -- "cursoId:aulaId:idx"
  streak int not null default 0,
  ok int not null default 0,
  fail int not null default 0,
  due timestamptz,
  last timestamptz,
  primary key (user_id, key)
);

-- Histórico de simulados
create table public.simulados (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  curso_id text not null,
  modulo_id text not null,
  score int not null,
  total int not null,
  created_at timestamptz not null default now()
);

-- Perfil (nome de exibição)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text
);

-- cria o profile automaticamente no signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)));
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- RLS
-- ============================================================
alter table public.cursos    enable row level security;
alter table public.modulos   enable row level security;
alter table public.attempts  enable row level security;
alter table public.simulados enable row level security;
alter table public.profiles  enable row level security;

-- conteúdo: qualquer usuário logado lê; ninguém escreve pela API
-- (você adiciona/edita módulos pelo SQL Editor do dashboard)
create policy "conteudo_leitura" on public.cursos  for select to authenticated using (true);
create policy "modulos_leitura"  on public.modulos for select to authenticated using (true);

-- progresso: cada um só vê e mexe no seu
create policy "attempts_select" on public.attempts for select to authenticated using (auth.uid() = user_id);
create policy "attempts_insert" on public.attempts for insert to authenticated with check (auth.uid() = user_id);
create policy "attempts_update" on public.attempts for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "simulados_select" on public.simulados for select to authenticated using (auth.uid() = user_id);
create policy "simulados_insert" on public.simulados for insert to authenticated with check (auth.uid() = user_id);

create policy "profiles_select" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles_update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- índices úteis
create index attempts_due_idx on public.attempts (user_id, due);
create index simulados_mod_idx on public.simulados (user_id, curso_id, modulo_id);
