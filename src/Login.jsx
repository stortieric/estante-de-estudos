import React, { useState } from "react";
import { supabase } from "./supabaseClient";

const grid =
  "linear-gradient(rgba(43,76,140,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(43,76,140,0.07) 1px, transparent 1px)";

export default function Login() {
  const [modo, setModo] = useState("entrar"); // entrar | criar
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (modo === "criar") {
        const { error } = await supabase.auth.signUp({
          email,
          password: senha,
          options: { data: { nome } },
        });
        if (error) throw error;
        setMsg({ ok: true, t: "Conta criada! Se a confirmação por e-mail estiver ativa no projeto, confira sua caixa de entrada antes de entrar." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
        if (error) throw error;
      }
    } catch (err) {
      setMsg({ ok: false, t: err.message || "Algo deu errado. Tente de novo." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.page}>
      <div style={s.box}>
        <div style={s.kicker}>estante de estudos</div>
        <h1 style={s.title}>{modo === "entrar" ? "Abrir o caderno" : "Criar sua conta"}</h1>

        <form onSubmit={submit}>
          {modo === "criar" && (
            <input style={s.input} placeholder="Seu nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
          )}
          <input style={s.input} type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <input style={s.input} type="password" placeholder="Senha (mín. 6 caracteres)" value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={6} autoComplete={modo === "criar" ? "new-password" : "current-password"} />
          <button style={s.btn} disabled={busy}>
            {busy ? "Um instante…" : modo === "entrar" ? "Entrar" : "Criar conta"}
          </button>
        </form>

        {msg && <div style={{ ...s.msg, borderColor: msg.ok ? "#2E7D5B" : "#C4453C", background: msg.ok ? "#E6F4EC" : "#FBEAE8" }}>{msg.t}</div>}

        <button style={s.toggle} onClick={() => { setModo(modo === "entrar" ? "criar" : "entrar"); setMsg(null); }}>
          {modo === "entrar" ? "Não tem conta? Criar uma" : "Já tem conta? Entrar"}
        </button>
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: "100vh", background: "#FBFBF7", backgroundImage: grid, backgroundSize: "22px 22px",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 18,
    fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif", color: "#1C2B3A", boxSizing: "border-box",
  },
  box: {
    width: "100%", maxWidth: 380, background: "#fff", border: "1.5px solid #1C2B3A", borderRadius: 12,
    padding: "26px 22px", boxShadow: "4px 4px 0 rgba(28,43,58,0.18)",
  },
  kicker: { fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#2B4C8C", fontWeight: 700 },
  title: { fontFamily: "Georgia, serif", fontSize: 26, margin: "8px 0 18px", lineHeight: 1.15 },
  input: {
    display: "block", width: "100%", boxSizing: "border-box", border: "1.5px solid #1C2B3A", borderRadius: 8,
    padding: "11px 12px", fontSize: 15, marginBottom: 10, font: "inherit", background: "#FBFBF7",
  },
  btn: {
    display: "block", width: "100%", background: "#2B4C8C", color: "#FBFBF7", border: "1.5px solid #1C2B3A",
    borderRadius: 8, padding: "11px 0", fontWeight: 700, fontSize: 15, cursor: "pointer", font: "inherit",
    boxShadow: "3px 3px 0 rgba(28,43,58,0.22)", marginTop: 4,
  },
  msg: { marginTop: 12, border: "1.5px solid", borderRadius: 8, padding: "9px 12px", fontSize: 13.5, lineHeight: 1.45 },
  toggle: { marginTop: 14, background: "none", border: "none", color: "#2B4C8C", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: 0, font: "inherit" },
};
