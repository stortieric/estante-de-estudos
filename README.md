# Estante de Estudos — Supabase + Vercel

App de estudo multi-curso com perfis individuais: teoria, exercícios (abertas, flashcards, múltipla escolha), repetição espaçada (1, 3, 7, 21, 45 dias) e simulados. Conteúdo mora no banco como JSONB — adicionar curso/módulo novo **não exige deploy**.

## Stack
- Front: Vite + React (SPA), deploy na Vercel
- Backend: Supabase (Postgres + Auth + RLS)
- Free tiers: Supabase permite 2 projetos ativos (pausa após 7 dias sem requisição — uso diário mantém vivo); Vercel Hobby aceita esse projeto tranquilamente

## Setup (uma vez, ~15 min)

### 1. Supabase
1. Crie um projeto novo em supabase.com (será seu 2º free).
2. **SQL Editor** → cole e rode `supabase/schema.sql` (tabelas + RLS + trigger de perfil).
3. **SQL Editor** → cole e rode `supabase/seed.sql` (cursos de Matemática e Espanhol).
4. **Authentication → Sign In / Up → Email**: deixe habilitado. Para testar sem fricção, desative "Confirm email" (pode religar depois).
5. **Project Settings → API**: copie a `URL` e a `anon public key`.

### 2. Local
```bash
cp .env.example .env   # preencha com URL e anon key
npm install
npm run dev
```

### 3. Vercel
1. Suba o repo no GitHub e importe na Vercel (framework: **Vite**, detectado sozinho).
2. Em **Environment Variables**, adicione `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
3. Deploy. Pronto — cada pessoa cria a própria conta e tem progresso isolado (RLS garante).

## Adicionando cursos e módulos (o fluxo "gero no Claude e subo")
O conteúdo é dado, não código:
- `cursos.curriculo` (JSONB): etapas → disciplinas, inclusive as pendentes
- `modulos.dados` (JSONB): `{ descricao, livros[], aulas[] }`, cada aula com `teoria[]`, `exemplos[]`, `exercicios[]`

Peça o módulo novo no projeto do Claude → ele gera um **SQL de insert** (mesmo formato do seed.sql) → cole no SQL Editor do Supabase → o módulo aparece no app na hora, pra todos os usuários. Pra ativar a disciplina no currículo, o insert também atualiza o `curriculo` do curso (`ativo: true`).

Formatos de exercício:
```json
{ "q": "pergunta", "a": "gabarito" }
{ "tipo": "card", "f": "frente", "v": "verso" }
{ "tipo": "mc", "q": "pergunta", "op": ["a", "b", "c", "d"], "c": 0, "e": "explicação" }
```

## Modelo de dados (progresso)
- `attempts (user_id, key, streak, ok, fail, due, last)` — key = `cursoId:aulaId:idx`; RLS: cada usuário só lê/escreve o próprio
- `simulados (user_id, curso_id, modulo_id, score, total)` — histórico de notas
- `profiles (id, nome)` — criado automaticamente no signup

Escrita nas tabelas de conteúdo é bloqueada pela API (sem policy de insert/update) — só você, via dashboard, publica conteúdo.

## Dicas
- O free do Supabase **não tem backup automático**: de vez em quando, Database → Backups não existe no free, então exporte via `pg_dump` ou um GitHub Action agendado se o progresso ficar valioso.
- Se o projeto pausar por inatividade (7 dias sem ninguém usar), é só reativar no dashboard — os dados ficam intactos.
