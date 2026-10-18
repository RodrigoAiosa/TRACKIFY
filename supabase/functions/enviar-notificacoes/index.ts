// Trackify: envia por e-mail (Resend) os avisos ainda não lidos e ainda não enviados.
// Chamada pelo agendamento diário (pg_cron + pg_net). Não é chamada pelo navegador.
//
// Segredos necessários (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY   chave da API do Resend
//   EMAIL_FROM       remetente, ex.: Trackify <nao-responda@envio.seudominio.com.br>
//   CRON_SECRET      texto longo e aleatório; o agendamento envia o mesmo texto no cabeçalho x-cron-secret
//   APP_URL          (opcional) endereço do sistema, para o link no e-mail
//   MAX_POR_EXECUCAO (opcional) limite de e-mails por execução, padrão 50 (o plano grátis do Resend permite 100/dia)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente dentro da função.

const env = (k: string) => Deno.env.get(k) ?? "";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function processar(req: Request): Promise<Response> {
  const segredo = env("CRON_SECRET");
  if (!segredo || req.headers.get("x-cron-secret") !== segredo) {
    return new Response("não autorizado", { status: 401 });
  }
  const base = env("SUPABASE_URL");
  const chave = env("SUPABASE_SERVICE_ROLE_KEY");
  const resend = env("RESEND_API_KEY");
  const de = env("EMAIL_FROM");
  if (!base || !chave || !resend || !de) {
    return new Response("configuração incompleta", { status: 500 });
  }
  const limite = Math.max(1, Math.min(200, Number(env("MAX_POR_EXECUCAO")) || 50));
  const app = env("APP_URL");
  const h = { apikey: chave, Authorization: `Bearer ${chave}`, "Content-Type": "application/json" };

  const consulta = `${base}/rest/v1/notificacoes?lida_em=is.null&email_enviado_em=is.null` +
    `&select=id,titulo,mensagem,perfis(email,nome_completo,ativo)&order=criado_em.asc&limit=${limite}`;
  const r = await fetch(consulta, { headers: h });
  if (!r.ok) return new Response("falha ao ler avisos", { status: 502 });
  const itens: Array<{ id: number; titulo: string; mensagem: string; perfis: { email: string | null; nome_completo: string; ativo: boolean } | null }> =
    await r.json();

  let enviados = 0, falhas = 0, ignorados = 0;
  for (const n of itens) {
    const para = n.perfis?.email;
    if (!para || n.perfis?.ativo === false) { ignorados++; continue; }
    const nome = esc((n.perfis?.nome_completo ?? "").split(" ")[0] || "olá");
    const link = app ? `<p><a href="${esc(app)}">Abrir o Trackify</a></p>` : "";
    const html = `<p>Olá, ${nome}.</p><p>${esc(n.mensagem)}</p>${link}<p style="color:#64748b;font-size:12px">Você recebe este aviso porque usa o Trackify.</p>`;
    const envio = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: de, to: [para], subject: `Trackify: ${n.titulo}`, html, text: `${n.mensagem}${app ? "\n" + app : ""}` }),
    });
    if (!envio.ok) { falhas++; continue; }
    const marca = await fetch(`${base}/rest/v1/notificacoes?id=eq.${n.id}`, {
      method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({ email_enviado_em: new Date().toISOString() }),
    });
    if (marca.ok) enviados++; else falhas++;
  }
  return new Response(JSON.stringify({ enviados, falhas, ignorados }), { headers: { "Content-Type": "application/json" } });
}

Deno.serve(processar);
