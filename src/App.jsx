import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import Login from "./Login.jsx";

/* ============================================================
   ESTANTE DE ESTUDOS — versão Supabase + Vercel
   Conteúdo vem das tabelas cursos/modulos (JSONB).
   Progresso individual em attempts/simulados (RLS por usuário).
   ============================================================ */

const DAY = 24 * 60 * 60 * 1000;
const INTERVALS = [1, 3, 7, 21, 45]; // dias — repetição espaçada

/* ---------- HELPERS ---------- */
function nextDue(streak) { return Date.now() + INTERVALS[Math.min(streak, INTERVALS.length - 1)] * DAY; }
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function findAula(cursos, cursoId, aulaId) {
  const curso = cursos[cursoId];
  if (!curso) return null;
  for (const mod of Object.values(curso.modulos)) {
    const aula = mod.aulas.find(a => a.id === aulaId);
    if (aula) return aula;
  }
  return null;
}
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 720);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 720);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

/* ---------- RETRY COM REFRESH DE SESSÃO ----------
   Tokens recém-emitidos podem ser rejeitados por desvio de relógio de
   poucos segundos entre os serviços do Supabase ("JWT issued at future").
   Renovar a sessão e tentar de novo com backoff resolve sem o usuário ver. */
async function comRetry(fn, tentativas = 3) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      const msg = (e && e.message ? e.message : String(e)).toLowerCase();
      const transitorio = msg.includes("future") || msg.includes("jwt") || msg.includes("expired");
      if (!transitorio) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      try { await supabase.auth.refreshSession(); } catch {}
    }
  }
  throw ultimoErro;
}

/* ---------- CARGA DE DADOS ---------- */
async function loadConteudo() {
  const [{ data: cursosRows, error: e1 }, { data: modRows, error: e2 }] = await Promise.all([
    supabase.from("cursos").select("*").order("ordem"),
    supabase.from("modulos").select("*"),
  ]);
  if (e1 || e2) throw (e1 || e2);
  const cursos = {};
  for (const c of cursosRows || []) {
    cursos[c.id] = {
      nome: c.nome, sub: c.sub, etiqueta: c.etiqueta,
      cor: c.cor, corSuave: c.cor_suave,
      curriculo: c.curriculo, modulos: {},
    };
  }
  for (const m of modRows || []) {
    if (cursos[m.curso_id]) cursos[m.curso_id].modulos[m.id] = m.dados;
  }
  return cursos;
}

async function loadProgresso(userId) {
  const [{ data: atts, error: e1 }, { data: sims, error: e2 }] = await Promise.all([
    supabase.from("attempts").select("*"),
    supabase.from("simulados").select("*").order("created_at"),
  ]);
  if (e1 || e2) throw (e1 || e2);
  const ex = {};
  for (const a of atts || []) {
    ex[a.key] = {
      streak: a.streak, ok: a.ok, fail: a.fail,
      due: a.due ? Date.parse(a.due) : null,
      last: a.last ? Date.parse(a.last) : null,
    };
  }
  const testes = {};
  for (const s of sims || []) {
    const k = `${s.curso_id}:${s.modulo_id}`;
    (testes[k] = testes[k] || []).push({ d: Date.parse(s.created_at), score: s.score, total: s.total });
  }
  return { ex, testes };
}

/* ============================ RAIZ ============================ */
export default function Root() {
  const [session, setSession] = useState(undefined); // undefined = carregando

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div style={{ padding: 40, fontFamily: "system-ui", color: "#1C2B3A" }}>Abrindo a estante…</div>;
  if (!session) return <Login />;
  return <App session={session} />;
}

/* ============================ APP ============================ */
function App({ session }) {
  const userId = session.user.id;
  const [cursos, setCursos] = useState(null);   // conteúdo (tabelas cursos/modulos)
  const [state, setState] = useState(null);     // progresso { ex, testes }
  const [erro, setErro] = useState(null);
  const [view, setView] = useState({ page: "home" });
  const [reveal, setReveal] = useState({});
  const [pick, setPick] = useState({});
  const wide = useWide();

  useEffect(() => {
    Promise.all([comRetry(loadConteudo), comRetry(() => loadProgresso(userId))])
      .then(([c, p]) => { setCursos(c); setState(p); })
      .catch((e) => setErro(e.message || String(e)));
  }, [userId]);

  /* grade: atualização otimista local + upsert no Supabase */
  const grade = useCallback((cursoId, aulaId, idx, ok) => {
    const key = `${cursoId}:${aulaId}:${idx}`;
    setState(prev => {
      const cur = prev.ex[key] || { streak: 0, ok: 0, fail: 0 };
      const streak = ok ? cur.streak + 1 : 0;
      const rec = {
        streak, ok: cur.ok + (ok ? 1 : 0), fail: cur.fail + (ok ? 0 : 1),
        due: ok ? nextDue(streak) : Date.now() + DAY, last: Date.now(),
      };
      supabase.from("attempts").upsert({
        user_id: userId, key,
        streak: rec.streak, ok: rec.ok, fail: rec.fail,
        due: new Date(rec.due).toISOString(), last: new Date(rec.last).toISOString(),
      }).then(({ error }) => { if (error) console.error("attempts upsert:", error.message); });
      return { ...prev, ex: { ...prev.ex, [key]: rec } };
    });
  }, [userId]);

  const salvarSimulado = useCallback((cursoId, moduloId, score, total) => {
    setState(prev => {
      const k = `${cursoId}:${moduloId}`;
      const hist = prev.testes[k] || [];
      return { ...prev, testes: { ...prev.testes, [k]: [...hist, { d: Date.now(), score, total }] } };
    });
    supabase.from("simulados").insert({ user_id: userId, curso_id: cursoId, modulo_id: moduloId, score, total })
      .then(({ error }) => { if (error) console.error("simulados insert:", error.message); });
  }, [userId]);

  const st = makeStyles(wide);

  if (erro) return (
    <div style={st.page}>
      <h1 style={st.h1}>Ops.</h1>
      <p style={st.p}>Não consegui carregar os dados: {erro}</p>
      <div style={st.gradeRow}>
        <button style={{ ...st.btnGrade, background: "#2B4C8C" }} onClick={() => window.location.reload()}>Tentar de novo</button>
        <button style={{ ...st.btnGrade, background: "#C4453C" }} onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }}>Sair e entrar de novo</button>
      </div>
      <p style={st.hint}>Se o problema persistir: confira se o schema.sql e o seed.sql foram executados no Supabase e se as variáveis VITE_SUPABASE_* estão configuradas.</p>
    </div>
  );
  if (!cursos || !state) return <div style={st.loading}>Abrindo a estante…</div>;
  if (Object.keys(cursos).length === 0) return (
    <div style={st.page}>
      <h1 style={st.h1}>Estante vazia</h1>
      <p style={st.p}>As tabelas existem mas não há cursos. Rode o supabase/seed.sql no SQL Editor do projeto.</p>
    </div>
  );

  /* ----- métricas ----- */
  const allEx = Object.entries(state.ex);
  const dueAll = allEx.filter(([, v]) => v.due && v.due <= Date.now());
  const statsCurso = (cursoId) => {
    const mine = allEx.filter(([k]) => k.startsWith(cursoId + ":"));
    const ok = mine.reduce((s, [, v]) => s + v.ok, 0);
    const fail = mine.reduce((s, [, v]) => s + v.fail, 0);
    return {
      feitos: ok + fail,
      taxa: ok + fail > 0 ? Math.round((100 * ok) / (ok + fail)) : null,
      due: mine.filter(([, v]) => v.due && v.due <= Date.now()).length,
    };
  };

  /* ---------- COMPONENTES ---------- */
  const Header = ({ title, back, cor }) => (
    <div style={st.header}>
      {back && <button style={{ ...st.back, color: cor || "#2B4C8C" }} onClick={() => setView(back)}>← voltar</button>}
      <h1 style={st.h1}>{title}</h1>
    </div>
  );

  const GradeButtons = ({ onOk, onFail }) => (
    <div style={st.gradeRow}>
      <button style={{ ...st.btnGrade, background: "#2E7D5B" }} onClick={onOk}>Acertei</button>
      <button style={{ ...st.btnGrade, background: "#C4453C" }} onClick={onFail}>Errei</button>
    </div>
  );

  /* Card de exercício — aberta, flashcard e múltipla escolha */
  const ExerciseCard = ({ cursoId, aulaId, idx, ex, cor, onGraded }) => {
    const key = `${cursoId}:${aulaId}:${idx}`;
    const rec = state.ex[key];
    const open = reveal[key];
    const chosen = pick[key];
    const acc = cor || "#2B4C8C";

    const doGrade = (ok) => {
      grade(cursoId, aulaId, idx, ok);
      setReveal(r => ({ ...r, [key]: false }));
      setPick(p => { const n = { ...p }; delete n[key]; return n; });
      onGraded && onGraded(ok);
    };

    const meta = rec && (
      <div style={st.exMeta}>
        {rec.ok + rec.fail} tentativa{rec.ok + rec.fail > 1 ? "s" : ""} · {rec.ok}✓ {rec.fail}✗
        {rec.due && <> · revisar {rec.due <= Date.now() ? "agora" : fmtDate(rec.due)}</>}
      </div>
    );

    if (ex.tipo === "card") {
      return (
        <div style={st.exCard}>
          <div style={st.cardTag(acc)}>flashcard</div>
          <div style={{ ...st.exQ, fontFamily: "Georgia, serif", fontSize: 17 }}>{ex.f}</div>
          {meta}
          {!open ? (
            <button style={st.btnGhost(acc)} onClick={() => setReveal(r => ({ ...r, [key]: true }))}>Virar carta</button>
          ) : (
            <>
              <div style={st.gabarito}>{ex.v}</div>
              <GradeButtons onOk={() => doGrade(true)} onFail={() => doGrade(false)} />
            </>
          )}
        </div>
      );
    }

    if (ex.tipo === "mc") {
      const answered = chosen !== undefined;
      return (
        <div style={st.exCard}>
          <div style={st.cardTag(acc)}>múltipla escolha</div>
          <div style={st.exQ}><span style={st.exNum}>{idx + 1}</span> {ex.q}</div>
          {meta}
          <div style={{ marginTop: 10 }}>
            {ex.op.map((op, i) => {
              let bg = "#fff", bd = "#1C2B3A";
              if (answered && i === ex.c) { bg = "#E6F4EC"; bd = "#2E7D5B"; }
              else if (answered && i === chosen && chosen !== ex.c) { bg = "#FBEAE8"; bd = "#C4453C"; }
              return (
                <button
                  key={i}
                  disabled={answered}
                  style={{ ...st.mcOpt, background: bg, borderColor: bd }}
                  onClick={() => { setPick(p => ({ ...p, [key]: i })); }}
                >
                  <b style={{ marginRight: 6 }}>{String.fromCharCode(97 + i)})</b> {op}
                </button>
              );
            })}
          </div>
          {answered && (
            <>
              <div style={st.gabarito}>{chosen === ex.c ? "✓ Isso!" : "✗ A correta é a " + String.fromCharCode(97 + ex.c) + ")."} {ex.e}</div>
              <button style={st.btnGhost(acc)} onClick={() => doGrade(chosen === ex.c)}>Registrar e fechar</button>
            </>
          )}
        </div>
      );
    }

    return (
      <div style={st.exCard}>
        <div style={st.exQ}><span style={st.exNum}>{idx + 1}</span> {ex.q}</div>
        {meta}
        {!open ? (
          <button style={st.btnGhost(acc)} onClick={() => setReveal(r => ({ ...r, [key]: true }))}>
            Resolvi — ver gabarito
          </button>
        ) : (
          <>
            <div style={st.gabarito}>{ex.a}</div>
            <GradeButtons onOk={() => doGrade(true)} onFail={() => doGrade(false)} />
          </>
        )}
      </div>
    );
  };

  /* ---------- PÁGINAS ---------- */

  if (view.page === "teste") {
    const curso = cursos[view.cursoId];
    return (
      <div style={st.page}>
        <Header title={"Simulado — " + view.modNome} back={{ page: "modulo", cursoId: view.cursoId, modId: view.modId }} cor={curso.cor} />
        <TesteRunner
          st={st}
          curso={curso}
          questoes={view.questoes}
          ExerciseCard={ExerciseCard}
          cursoId={view.cursoId}
          onFinish={(score, total) => salvarSimulado(view.cursoId, view.modId, score, total)}
          onExit={() => setView({ page: "modulo", cursoId: view.cursoId, modId: view.modId })}
        />
      </div>
    );
  }

  if (view.page === "aula") {
    const curso = cursos[view.cursoId];
    const mod = curso.modulos[view.modId];
    const aula = mod.aulas.find(a => a.id === view.aulaId);
    const nomeMod = curso.curriculo.flatMap(e => e.disciplinas).find(d => d.id === view.modId)?.nome || "";
    return (
      <div style={st.page}>
        <div style={st.reading}>
          <Header title={aula.titulo} back={{ page: "modulo", cursoId: view.cursoId, modId: view.modId }} cor={curso.cor} />
          <div style={st.eyebrow(curso.cor)}>{aula.semanas} · {nomeMod}</div>

          <h2 style={st.h2}><mark style={st.mark}>Teoria</mark></h2>
          {aula.teoria.map((p, i) => <p key={i} style={st.p}>{p}</p>)}

          <h2 style={st.h2}><mark style={st.mark}>Exemplos resolvidos</mark></h2>
          {aula.exemplos.map((e, i) => (
            <div key={i} style={st.exemplo(curso.cor, curso.corSuave)}>
              <div style={st.exemploT(curso.cor)}>{e.t}</div>
              <div style={st.exemploC}>{e.c}</div>
            </div>
          ))}

          <h2 style={st.h2}><mark style={st.mark}>Exercícios</mark></h2>
          <p style={st.hint}>Resolva (ou fale em voz alta, no caso de idiomas) antes de abrir o gabarito.</p>
          {aula.exercicios.map((ex, i) => (
            <ExerciseCard key={i} cursoId={view.cursoId} aulaId={aula.id} idx={i} ex={ex} cor={curso.cor} />
          ))}
        </div>
      </div>
    );
  }

  if (view.page === "modulo") {
    const curso = cursos[view.cursoId];
    const mod = curso.modulos[view.modId];
    const nomeMod = curso.curriculo.flatMap(e => e.disciplinas).find(d => d.id === view.modId)?.nome || "";
    const mk = `${view.cursoId}:${view.modId}`;
    const historico = (state.testes[mk] || []).slice(-3).reverse();
    const totalQ = mod.aulas.reduce((s, a) => s + a.exercicios.length, 0);

    const iniciarSimulado = () => {
      const pool = mod.aulas.flatMap(a => a.exercicios.map((ex, i) => ({ aulaId: a.id, idx: i, ex })));
      const questoes = shuffle(pool).slice(0, Math.min(10, pool.length));
      setView({ page: "teste", cursoId: view.cursoId, modId: view.modId, modNome: nomeMod, questoes });
    };

    return (
      <div style={st.page}>
        <Header title={nomeMod} back={{ page: "curso", cursoId: view.cursoId }} cor={curso.cor} />
        <p style={st.p}>{mod.descricao}</p>

        <button style={st.btnSimulado(curso.cor)} onClick={iniciarSimulado}>
          ▶ Simulado: 10 questões aleatórias ({totalQ} no total)
        </button>
        {historico.length > 0 && (
          <div style={st.testHist}>
            Últimos simulados: {historico.map((t, i) => (
              <span key={i} style={st.testChip(t.score / t.total >= 0.7)}>{t.score}/{t.total} · {fmtDate(t.d)}</span>
            ))}
          </div>
        )}

        <div style={st.cardsGrid}>
          {mod.aulas.map(a => {
            const exs = a.exercicios.map((_, i) => state.ex[`${view.cursoId}:${a.id}:${i}`]).filter(Boolean);
            const done = exs.filter(e => e.streak > 0).length;
            return (
              <button key={a.id} style={st.aulaCard} onClick={() => setView({ page: "aula", cursoId: view.cursoId, modId: view.modId, aulaId: a.id })}>
                <div style={st.aulaTitle}>{a.titulo}</div>
                <div style={st.aulaSub}>{a.semanas} · {a.exercicios.length} exercícios</div>
                <div style={st.squares}>
                  {a.exercicios.map((_, i) => {
                    const r = state.ex[`${view.cursoId}:${a.id}:${i}`];
                    const bg = !r ? "transparent" : r.streak > 0 ? "#2E7D5B" : "#C4453C";
                    return <span key={i} style={{ ...st.sq, background: bg }} />;
                  })}
                </div>
                {done === a.exercicios.length && a.exercicios.length > 0 && <div style={st.doneTag}>✓ completa</div>}
              </button>
            );
          })}
        </div>

        <h2 style={st.h2}><mark style={st.mark}>Bibliografia</mark></h2>
        {mod.livros.map((l, i) => <p key={i} style={st.livro}>📕 {l}</p>)}
      </div>
    );
  }

  if (view.page === "curso") {
    const curso = cursos[view.cursoId];
    const s = statsCurso(view.cursoId);
    return (
      <div style={st.page}>
        <Header title={curso.nome} back={{ page: "home" }} cor={curso.cor} />
        <div style={st.eyebrow(curso.cor)}>{curso.sub}</div>

        <div style={st.statRow}>
          <div style={st.stat}><div style={st.statN}>{s.taxa === null ? "—" : s.taxa + "%"}</div><div style={st.statL}>acerto</div></div>
          <div style={st.stat}><div style={st.statN}>{s.feitos}</div><div style={st.statL}>resolvidos</div></div>
          <button style={{ ...st.stat, ...(s.due ? st.statAlert : {}) }} onClick={() => setView({ page: "revisao", cursoId: view.cursoId })}>
            <div style={st.statN}>{s.due}</div><div style={st.statL}>revisar hoje</div>
          </button>
        </div>

        {curso.curriculo.map(et => (
          <div key={et.etapa}>
            <h2 style={st.h2}><mark style={st.mark}>{et.etapa}</mark></h2>
            <div style={st.cardsGrid}>
              {et.disciplinas.map(d => {
                const temConteudo = d.ativo && curso.modulos[d.id];
                return (
                  <button
                    key={d.id}
                    style={{ ...st.discCard, opacity: temConteudo ? 1 : 0.55 }}
                    onClick={() => temConteudo && setView({ page: "modulo", cursoId: view.cursoId, modId: d.id })}
                    disabled={!temConteudo}
                  >
                    <div style={st.discName}>{d.nome}</div>
                    <div style={st.discSub}>
                      {d.ch} h/semana · ~{d.ch * 18}h no semestre
                      {temConteudo ? ` · ${d.nota || "disponível"}` : " · em breve"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (view.page === "revisao") {
    const filtro = view.cursoId ? ([k]) => k.startsWith(view.cursoId + ":") : () => true;
    const pendentes = dueAll.filter(filtro);
    return (
      <div style={st.page}>
        <Header
          title={view.cursoId ? "Revisões — " + cursos[view.cursoId].nome : "Revisões de hoje"}
          back={view.cursoId ? { page: "curso", cursoId: view.cursoId } : { page: "home" }}
        />
        <p style={st.hint}>Repetição espaçada: acertos empurram a revisão para {INTERVALS.join(", ")} dias. Erros voltam amanhã.</p>
        {pendentes.length === 0 && <p style={st.p}>Nada pendente. 🎉 Volte amanhã ou avance nas aulas.</p>}
        {pendentes.map(([key]) => {
          const [cursoId, aulaId, idxStr] = key.split(":");
          const idx = Number(idxStr);
          const curso = cursos[cursoId];
          const aula = findAula(cursos, cursoId, aulaId);
          if (!curso || !aula || !aula.exercicios[idx]) return null;
          return (
            <div key={key}>
              <div style={st.eyebrow(curso.cor)}>{curso.nome} · {aula.titulo}</div>
              <ExerciseCard cursoId={cursoId} aulaId={aulaId} idx={idx} ex={aula.exercicios[idx]} cor={curso.cor} />
            </div>
          );
        })}
      </div>
    );
  }

  /* ----- HOME: a estante ----- */
  const nomeUser = session.user.user_metadata?.nome || session.user.email;
  return (
    <div style={st.page}>
      <div style={st.topbar}>
        <span style={st.topbarUser}>✎ {nomeUser}</span>
        <button style={st.topbarSair} onClick={() => supabase.auth.signOut()}>sair</button>
      </div>

      <div style={st.hero}>
        <div style={st.heroKicker}>estante de estudos</div>
        <h1 style={st.heroTitle}>Um caderno<br />pra cada curso.</h1>
        <div style={st.heroSub}>teoria · exercícios · repetição espaçada · simulados</div>
      </div>

      {dueAll.length > 0 && (
        <button style={st.dueBanner} onClick={() => setView({ page: "revisao" })}>
          🔔 {dueAll.length} exercício{dueAll.length > 1 ? "s" : ""} pra revisar hoje — tocar pra começar
        </button>
      )}

      <div style={st.shelfGrid}>
        {Object.entries(cursos).map(([id, c]) => {
          const s = statsCurso(id);
          const nMods = c.curriculo.flatMap(e => e.disciplinas).length;
          const nAtivos = c.curriculo.flatMap(e => e.disciplinas).filter(d => d.ativo && c.modulos[d.id]).length;
          return (
            <button key={id} style={st.capa(c.cor)} onClick={() => setView({ page: "curso", cursoId: id })}>
              <div style={st.capaEspiral} />
              <div style={st.capaMiolo}>
                <div style={st.capaEtiqueta}>
                  <div style={st.capaNome}>{c.nome}</div>
                  <div style={st.capaEtq}>{c.etiqueta}</div>
                </div>
                <div style={st.capaInfo}>
                  {nAtivos}/{nMods} módulos prontos
                  {s.feitos > 0 && <> · {s.feitos} resolvidos{s.taxa !== null && ` · ${s.taxa}% acerto`}</>}
                  {s.due > 0 && <span style={st.capaDue}> · {s.due} pra revisar</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
/* ---------- SIMULADO: runner ---------- */
function TesteRunner({ st, curso, questoes, ExerciseCard, cursoId, onFinish, onExit }) {
  const [i, setI] = useState(0);
  const [score, setScore] = useState(0);
  const [fim, setFim] = useState(false);

  if (fim) {
    const pct = Math.round((100 * score) / questoes.length);
    return (
      <div>
        <div style={st.testResult(pct >= 70)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 34, fontWeight: 700 }}>{score}/{questoes.length}</div>
          <div style={{ fontSize: 14 }}>{pct >= 70 ? "Mandou bem — segue o baile." : "Abaixo de 70% — vale revisar as aulas antes do próximo simulado."}</div>
        </div>
        <button style={st.btnSimulado(curso.cor)} onClick={onExit}>Voltar ao módulo</button>
      </div>
    );
  }

  const q = questoes[i];
  const avancar = (ok) => {
    const novo = score + (ok ? 1 : 0);
    if (i + 1 >= questoes.length) {
      setScore(novo);
      setFim(true);
      onFinish(novo, questoes.length);
    } else {
      setScore(novo);
      setI(i + 1);
    }
  };

  return (
    <div>
      <div style={st.testProgress}>
        Questão {i + 1} de {questoes.length} · {score} certa{score !== 1 ? "s" : ""} até agora
        <div style={st.testBar}><div style={{ ...st.testBarFill, width: `${(100 * i) / questoes.length}%`, background: curso.cor }} /></div>
      </div>
      <ExerciseCard
        key={`${q.aulaId}:${q.idx}:${i}`}
        cursoId={cursoId}
        aulaId={q.aulaId}
        idx={q.idx}
        ex={q.ex}
        cor={curso.cor}
        onGraded={avancar}
      />
      <p style={st.hint}>Cada resposta também alimenta a repetição espaçada — o simulado conta como estudo.</p>
    </div>
  );
}

/* ---------- ESTILO: caderno quadriculado, responsivo ---------- */
const grid =
  "linear-gradient(rgba(43,76,140,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(43,76,140,0.07) 1px, transparent 1px)";

function makeStyles(wide) {
  return {
    page: {
      minHeight: "100vh", background: "#FBFBF7", backgroundImage: grid, backgroundSize: "22px 22px",
      color: "#1C2B3A", fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif",
      padding: wide ? "28px 32px 80px" : "20px 18px 60px",
      maxWidth: wide ? 1000 : 680, margin: "0 auto", boxSizing: "border-box",
    },
    reading: { maxWidth: 760, margin: "0 auto" }, // aulas: coluna de leitura confortável mesmo no tablet
    loading: { padding: 40, fontFamily: "system-ui", color: "#1C2B3A" },

    header: { marginBottom: 4 },
    back: { background: "none", border: "none", fontSize: 14, padding: 0, marginBottom: 10, cursor: "pointer", fontWeight: 600 },
    h1: { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: wide ? 30 : 26, margin: "0 0 6px", lineHeight: 1.2 },
    h2: { fontFamily: "Georgia, serif", fontSize: 19, margin: "28px 0 12px" },
    mark: { background: "linear-gradient(transparent 55%, #FFD84D 55%)", padding: "0 4px" },
    eyebrow: (cor) => ({ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: cor, fontWeight: 700, margin: "6px 0 14px" }),
    p: { fontSize: 15.5, lineHeight: 1.65, margin: "0 0 12px" },
    hint: { fontSize: 13.5, lineHeight: 1.5, color: "#5A6B7D", margin: "10px 0 16px", fontStyle: "italic" },

    /* home / estante */
    hero: { padding: wide ? "34px 0 22px" : "26px 0 18px" },
    heroKicker: { fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#2B4C8C", fontWeight: 700 },
    heroTitle: { fontFamily: "Georgia, serif", fontSize: wide ? 44 : 34, lineHeight: 1.1, margin: "8px 0 8px" },
    heroSub: { fontSize: 14, color: "#5A6B7D" },

    dueBanner: {
      display: "block", width: "100%", textAlign: "left", background: "#FFF4F2", border: "1.5px solid #C4453C",
      color: "#8F2F27", borderRadius: 10, padding: "12px 14px", marginBottom: 16, cursor: "pointer",
      fontWeight: 700, fontSize: 14, boxShadow: "3px 3px 0 rgba(28,43,58,0.12)", font: "inherit",
    },

    shelfGrid: { display: "grid", gridTemplateColumns: wide ? "1fr 1fr" : "1fr", gap: 14, marginTop: 8 },
    capa: (cor) => ({
      position: "relative", display: "flex", alignItems: "stretch", textAlign: "left",
      background: cor, color: "#FBFBF7", border: "1.5px solid #1C2B3A", borderRadius: "6px 14px 14px 6px",
      padding: 0, cursor: "pointer", boxShadow: "4px 4px 0 rgba(28,43,58,0.22)", overflow: "hidden",
      font: "inherit", minHeight: 118,
    }),
    capaEspiral: {
      width: 18, flexShrink: 0, borderRight: "1.5px dashed rgba(251,251,247,0.55)",
      backgroundImage: "radial-gradient(circle, rgba(251,251,247,0.75) 2px, transparent 2.5px)",
      backgroundSize: "18px 16px", backgroundPosition: "center 8px",
    },
    capaMiolo: { padding: "16px 16px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 },
    capaEtiqueta: {
      background: "#FBFBF7", color: "#1C2B3A", borderRadius: 4, padding: "8px 12px",
      border: "1px solid rgba(28,43,58,0.3)", transform: "rotate(-0.6deg)", alignSelf: "flex-start",
      boxShadow: "0 1px 0 rgba(0,0,0,0.15)",
    },
    capaNome: { fontFamily: "Georgia, serif", fontWeight: 700, fontSize: 21, lineHeight: 1.1 },
    capaEtq: { fontSize: 11.5, textTransform: "uppercase", letterSpacing: 1, color: "#5A6B7D", marginTop: 2 },
    capaInfo: { fontSize: 12.5, marginTop: 12, opacity: 0.95 },
    capaDue: { fontWeight: 700, textDecoration: "underline" },
    capaNova: {
      border: "1.5px dashed #5A6B7D", borderRadius: 12, padding: "18px 16px", color: "#5A6B7D",
      fontSize: 13.5, lineHeight: 1.5, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 118, boxSizing: "border-box",
    },

    /* estatísticas */
    statRow: { display: "flex", gap: 10, margin: "14px 0 8px" },
    stat: { flex: 1, background: "#fff", border: "1.5px solid #1C2B3A", borderRadius: 10, padding: "12px 8px", textAlign: "center", cursor: "pointer", boxShadow: "3px 3px 0 rgba(28,43,58,0.12)", font: "inherit", color: "inherit" },
    statAlert: { borderColor: "#C4453C", background: "#FFF4F2" },
    statN: { fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 700 },
    statL: { fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.8, color: "#5A6B7D", marginTop: 2 },

    /* grades responsivas de cards */
    cardsGrid: { display: "grid", gridTemplateColumns: wide ? "1fr 1fr" : "1fr", gap: 10 },
    exGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 0 },

    discCard: { display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1.5px solid #1C2B3A", borderRadius: 10, padding: "13px 14px", cursor: "pointer", boxShadow: "3px 3px 0 rgba(28,43,58,0.12)", font: "inherit", color: "inherit" },
    discName: { fontWeight: 700, fontSize: 15.5 },
    discSub: { fontSize: 12.5, color: "#5A6B7D", marginTop: 3 },

    aulaCard: { display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1.5px solid #1C2B3A", borderRadius: 10, padding: "14px 15px", cursor: "pointer", boxShadow: "3px 3px 0 rgba(28,43,58,0.12)", font: "inherit", color: "inherit" },
    aulaTitle: { fontFamily: "Georgia, serif", fontWeight: 700, fontSize: 16.5 },
    aulaSub: { fontSize: 12.5, color: "#5A6B7D", margin: "3px 0 8px" },
    squares: { display: "flex", gap: 4, flexWrap: "wrap" },
    sq: { width: 13, height: 13, border: "1.2px solid #1C2B3A", borderRadius: 2, display: "inline-block" },
    doneTag: { marginTop: 8, fontSize: 12.5, fontWeight: 700, color: "#2E7D5B" },

    exemplo: (cor, suave) => ({ background: suave, borderLeft: "4px solid " + cor, borderRadius: "0 8px 8px 0", padding: "11px 13px", marginBottom: 10 }),
    exemploT: (cor) => ({ fontWeight: 700, fontSize: 13.5, color: cor, marginBottom: 3 }),
    exemploC: { fontSize: 14.5, lineHeight: 1.55 },

    exCard: { background: "#fff", border: "1.5px solid #1C2B3A", borderRadius: 10, padding: "13px 14px", marginBottom: 12, boxShadow: "3px 3px 0 rgba(28,43,58,0.12)" },
    exQ: { fontSize: 15, lineHeight: 1.55 },
    exNum: { display: "inline-block", background: "#1C2B3A", color: "#FFD84D", fontWeight: 700, fontSize: 12.5, borderRadius: 5, padding: "1px 7px", marginRight: 6 },
    exMeta: { fontSize: 12, color: "#5A6B7D", marginTop: 6 },
    cardTag: (cor) => ({ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, color: cor, marginBottom: 6 }),
    btnGhost: (cor) => ({ marginTop: 10, background: "none", border: "1.5px dashed " + cor, color: cor, borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", font: "inherit" }),
    gabarito: { marginTop: 10, background: "#FFFBE6", border: "1px solid #E8D77A", borderRadius: 8, padding: "10px 12px", fontSize: 14.5, lineHeight: 1.55 },
    gradeRow: { display: "flex", gap: 8, marginTop: 10 },
    btnGrade: { flex: 1, border: "none", color: "#fff", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", font: "inherit" },

    mcOpt: {
      display: "block", width: "100%", textAlign: "left", border: "1.5px solid #1C2B3A", borderRadius: 8,
      padding: "9px 12px", marginBottom: 6, fontSize: 14, cursor: "pointer", font: "inherit", color: "inherit",
    },

    /* simulado */
    btnSimulado: (cor) => ({
      display: "block", width: "100%", background: cor, color: "#FBFBF7", border: "1.5px solid #1C2B3A",
      borderRadius: 10, padding: "12px 14px", fontWeight: 700, fontSize: 14.5, cursor: "pointer",
      boxShadow: "3px 3px 0 rgba(28,43,58,0.22)", margin: "6px 0 10px", font: "inherit", textAlign: "left",
    }),
    testHist: { fontSize: 12.5, color: "#5A6B7D", margin: "0 0 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
    testChip: (ok) => ({
      display: "inline-block", background: ok ? "#E6F4EC" : "#FBEAE8", border: "1px solid " + (ok ? "#2E7D5B" : "#C4453C"),
      color: ok ? "#1E5C41" : "#8F2F27", borderRadius: 6, padding: "2px 8px", fontWeight: 700,
    }),
    testProgress: { fontSize: 13, color: "#5A6B7D", margin: "10px 0 12px" },
    testBar: { height: 8, background: "#EDEDE5", border: "1px solid #1C2B3A", borderRadius: 6, marginTop: 6, overflow: "hidden" },
    testBarFill: { height: "100%", transition: "width .3s" },
    testResult: (ok) => ({
      background: ok ? "#E6F4EC" : "#FBEAE8", border: "1.5px solid " + (ok ? "#2E7D5B" : "#C4453C"),
      borderRadius: 12, padding: "22px 18px", textAlign: "center", margin: "16px 0 14px",
      boxShadow: "3px 3px 0 rgba(28,43,58,0.12)",
    }),

    topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#5A6B7D" },
    topbarUser: { fontWeight: 600 },
    topbarSair: { background: "none", border: "1.5px dashed #5A6B7D", color: "#5A6B7D", borderRadius: 8, padding: "4px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", font: "inherit" },

    livro: { fontSize: 14, lineHeight: 1.5, margin: "0 0 8px" },
  };
}
