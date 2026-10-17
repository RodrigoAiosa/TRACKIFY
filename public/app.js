const SUPABASE_URL = "https://yoywnhuewdxkfuqwrbbt.supabase.co";
const SUPABASE_KEY = "sb_publishable_5LW2Y6nn91TMXBbK3CADMg_DvdsypxT"; // Publishable Key (pública por definição; o acesso é protegido por RLS no banco)

// Atenção: o SDK do CDN já cria a variável global "supabase". Por isso o cliente se chama "sb".
let sb;

// Garante que o script só roda após o HTML carregar por completo
document.addEventListener("DOMContentLoaded", () => {

    // ---------------------------------------------------------------
    // Inicialização
    // ---------------------------------------------------------------
    if (window.supabase) {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
        console.error("SDK do Supabase não foi carregado.");
    }

    const $ = (id) => document.getElementById(id);

    const authScreen = $("auth-screen");
    const appScreen = $("app-screen");
    const loginForm = $("login-form");
    const registerForm = $("register-form");
    const userDisplay = $("user-display");

    // Estado da tela do colaborador
    let usuario = null;
    let perfil = null;
    let projetos = [];
    let tipos = [];
    let rascunhos = [];      // atividades adicionadas, ainda não confirmadas
    let pontoDoDia = null;   // lançamento já existente na data selecionada
    let salvando = false;
    let reqDia = 0;          // evita resposta atrasada sobrescrever a data atual

    const PRIORIDADES = { 1: "Alta", 2: "Média", 3: "Baixa" };

    // ---------------------------------------------------------------
    // Utilitários
    // ---------------------------------------------------------------
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));

    function dataISO(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function fmtMin(min) {
        min = Math.max(0, Math.round(Number(min) || 0));
        return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
    }

    function fmtData(iso) {
        const [y, m, d] = iso.split("-");
        const dias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
        return `${d}/${m}/${y} (${dias[new Date(+y, +m - 1, +d).getDay()]})`;
    }

    const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
    const paraMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

    function toast(msg, tipo = "ok") {
        const cores = { ok: "bg-emerald-600", erro: "bg-red-600", aviso: "bg-amber-600" };
        const el = document.createElement("div");
        el.className = `${cores[tipo] || cores.ok} text-white text-sm px-4 py-3 rounded-lg shadow-lg max-w-sm`;
        el.textContent = msg;
        $("toast-container").appendChild(el);
        setTimeout(() => el.remove(), tipo === "erro" ? 6000 : 3500);
    }

    function msgErro(error) {
        const m = (error && error.message) || "Erro inesperado.";
        if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
        if (/Email not confirmed/i.test(m)) return "E-mail ainda não confirmado. Verifique sua caixa de entrada.";
        if (/already registered|already been registered/i.test(m)) return "Este e-mail já está cadastrado.";
        if (/Database error saving new user/i.test(m)) return "Não foi possível concluir o cadastro. Verifique se o e-mail já foi usado.";
        if (/row-level security|permission denied/i.test(m)) return "Operação não permitida: o registro pode estar travado ou já avaliado pelo gestor.";
        return m;
    }

    function confirmarModal({ titulo, texto, botao = "Excluir" }) {
        return new Promise((resolve) => {
            const modal = $("modal");
            $("modal-titulo").textContent = titulo;
            $("modal-texto").textContent = texto;
            $("modal-confirmar").textContent = botao;
            modal.classList.remove("hidden");
            $("modal-cancelar").focus();

            const onKey = (e) => { if (e.key === "Escape") fechar(false); };
            const fechar = (resposta) => {
                modal.classList.add("hidden");
                $("modal-confirmar").onclick = null;
                $("modal-cancelar").onclick = null;
                document.removeEventListener("keydown", onKey);
                resolve(resposta);
            };
            document.addEventListener("keydown", onKey);
            $("modal-confirmar").onclick = () => fechar(true);
            $("modal-cancelar").onclick = () => fechar(false);
        });
    }

    // ---------------------------------------------------------------
    // Alternar Login / Cadastro
    // ---------------------------------------------------------------
    const btnShowRegister = $("btn-show-register");
    if (btnShowRegister) {
        btnShowRegister.addEventListener("click", (e) => {
            e.preventDefault();
            loginForm.classList.add("hidden");
            registerForm.classList.remove("hidden");
        });
    }

    const btnShowLogin = $("btn-show-login");
    if (btnShowLogin) {
        btnShowLogin.addEventListener("click", (e) => {
            e.preventDefault();
            registerForm.classList.add("hidden");
            loginForm.classList.remove("hidden");
        });
    }

    // ---------------------------------------------------------------
    // Login
    // ---------------------------------------------------------------
    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (!sb) return toast("Erro ao conectar ao banco de dados.", "erro");

            const email = $("login-email").value;
            const password = $("login-password").value;
            const { data, error } = await sb.auth.signInWithPassword({ email, password });

            if (error) {
                toast(msgErro(error), "erro");
            } else {
                carregarApp(data.user);
            }
        });
    }

    // ---------------------------------------------------------------
    // Cadastro
    // ---------------------------------------------------------------
    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const nome = $("reg-nome").value;
            const sexo = $("reg-sexo").value;
            const email = $("reg-email").value;
            const celular = $("reg-celular").value;
            const password = $("reg-password").value;
            const passwordConfirm = $("reg-password-confirm").value;
            const passwordError = $("reg-password-error");

            if (password !== passwordConfirm) {
                if (passwordError) passwordError.classList.remove("hidden");
                return;
            }
            if (passwordError) passwordError.classList.add("hidden");

            if (!sb) return toast("Erro ao conectar ao banco de dados.", "erro");

            // O perfil (role) é sempre definido como 'colaborador' no banco.
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        nome_completo: nome.trim(),
                        username: email.split("@")[0],
                        sexo: sexo,
                        celular: celular.trim()
                    }
                }
            });

            if (error) {
                toast(msgErro(error), "erro");
            } else if (data.session) {
                toast("Cadastro realizado! Bem-vindo(a).");
                carregarApp(data.user);
            } else {
                toast("Cadastro realizado! Confirme seu e-mail para entrar.", "aviso");
                registerForm.classList.add("hidden");
                loginForm.classList.remove("hidden");
            }
        });
    }

    // ---------------------------------------------------------------
    // Logout
    // ---------------------------------------------------------------
    const btnLogout = $("btn-logout");
    if (btnLogout) {
        btnLogout.addEventListener("click", async () => {
            if (sb) await sb.auth.signOut();
            location.reload();
        });
    }

    // ---------------------------------------------------------------
    // Carregar app após login
    // ---------------------------------------------------------------
    async function carregarApp(user) {
        usuario = user;
        authScreen.classList.add("hidden");
        appScreen.classList.remove("hidden");
        userDisplay.textContent = user.email;

        const { data: p } = await sb.from("perfis")
            .select("nome_completo, role, permite_fim_semana")
            .eq("id", user.id).maybeSingle();
        perfil = p;

        if (perfil) {
            userDisplay.textContent = perfil.nome_completo || user.email;
            const roleBadge = $("user-role-badge");
            const nomes = { colaborador: "Colaborador", gestor: "Gestor", admin: "Admin" };
            if (roleBadge) roleBadge.textContent = nomes[perfil.role] || perfil.role;
            if (perfil.role === "gestor" || perfil.role === "admin") {
                const tabAprovacao = $("tab-aprovação");
                if (tabAprovacao) tabAprovacao.classList.remove("hidden");
            }
        }

        $("ponto-data").value = dataISO(new Date());
        await carregarApoio();
        renderRascunhos();
        await Promise.all([carregarDia($("ponto-data").value), carregarLancamentos()]);
    }

    // ---------------------------------------------------------------
    // Listas de apoio (projetos e tipos de atividade)
    // ---------------------------------------------------------------
    async function carregarApoio() {
        const [p, t] = await Promise.all([
            sb.from("projetos").select("id, nome_projeto").eq("ativo", true).order("nome_projeto"),
            sb.from("tipos_atividade").select("id, nome").eq("ativo", true).order("nome")
        ]);
        projetos = p.data || [];
        tipos = t.data || [];
        $("atv-projeto").innerHTML = projetos.map((x) => `<option value="${x.id}">${esc(x.nome_projeto)}</option>`).join("");
        $("atv-tipo").innerHTML = tipos.map((x) => `<option value="${x.id}">${esc(x.nome)}</option>`).join("");
    }

    const nomeProjeto = (id) => (projetos.find((x) => x.id === id) || {}).nome_projeto || "Sem projeto";
    const nomeTipo = (id) => (tipos.find((x) => x.id === id) || {}).nome || "Sem tipo";

    // ---------------------------------------------------------------
    // Horários e totais
    // ---------------------------------------------------------------
    function lerHorarios() {
        const pares = [1, 2, 3].map((n) => ({ n, e: $(`ponto-entrada-${n}`).value, s: $(`ponto-saida-${n}`).value }));
        let minutos = 0;
        for (const p of pares) {
            if (!p.e && !p.s) continue;
            if (!p.e || !p.s) return { erro: `Preencha entrada e saída do período ${p.n}.` };
            const dif = paraMin(p.s) - paraMin(p.e);
            if (dif <= 0) return { erro: `No período ${p.n}, a saída deve ser depois da entrada.` };
            minutos += dif;
        }
        if (!minutos) return { erro: "Informe ao menos um período de entrada e saída." };
        return { pares, minutos };
    }

    function minutosPontoParcial() {
        let total = 0;
        for (const n of [1, 2, 3]) {
            const e = $(`ponto-entrada-${n}`).value;
            const s = $(`ponto-saida-${n}`).value;
            if (e && s && paraMin(s) > paraMin(e)) total += paraMin(s) - paraMin(e);
        }
        return total;
    }

    function atualizarTotais() {
        const minPonto = minutosPontoParcial();
        $("ponto-total").textContent = fmtMin(minPonto);

        const salvas = ((pontoDoDia && pontoDoDia.atividades) || [])
            .reduce((s, a) => s + (a.duracao_realizada_minutos || 0), 0);
        const novas = rascunhos.reduce((s, a) => s + a.duracao_realizada_minutos, 0);
        const resumo = $("atividades-resumo");

        let txt = `Atividades: ${fmtMin(salvas + novas)}`;
        if (salvas && novas) txt += ` (já lançadas ${fmtMin(salvas)} + novas ${fmtMin(novas)})`;
        if (minPonto) {
            const dif = minPonto - (salvas + novas);
            if (dif > 0) txt += ` · faltam ${fmtMin(dif)} para completar o ponto`;
            else if (dif < 0) txt += ` · ${fmtMin(-dif)} a mais que o ponto`;
            else txt += " · fecha com o ponto";
        }
        resumo.textContent = txt;
        resumo.className = "text-xs " + (minPonto && (salvas + novas) > minPonto ? "text-amber-400" : "text-gray-400");
    }

    // ---------------------------------------------------------------
    // Atividades a confirmar (rascunho)
    // ---------------------------------------------------------------
    function renderRascunhos() {
        const box = $("rascunho-lista");
        if (!rascunhos.length) {
            box.innerHTML = `<p class="text-sm text-gray-500">Nenhuma atividade adicionada ainda.</p>`;
        } else {
            box.innerHTML = rascunhos.map((a, i) => `
                <div class="flex items-start justify-between gap-3 bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                    <div class="min-w-0">
                        <p class="text-sm text-gray-100 break-words">${esc(a.descricao_atividade)}</p>
                        <p class="text-xs text-gray-400 mt-1">${esc(nomeProjeto(a.projeto_id))} · ${esc(nomeTipo(a.tipo_atividade_id))} · Prioridade ${PRIORIDADES[a.prioridade_dia] || a.prioridade_dia} · ${fmtMin(a.duracao_realizada_minutos)} realizadas (previstas ${fmtMin(a.duracao_prevista_minutos)})</p>
                        ${a.intercorrencias ? `<p class="text-xs text-amber-300 mt-1">Intercorrência: ${esc(a.intercorrencias)}</p>` : ""}
                    </div>
                    <button type="button" data-remover="${i}" class="text-xs px-2.5 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 shrink-0">Remover</button>
                </div>`).join("");
        }
        atualizarTotais();
    }

    $("rascunho-lista").addEventListener("click", (e) => {
        const b = e.target.closest("[data-remover]");
        if (!b) return;
        rascunhos.splice(Number(b.dataset.remover), 1);
        renderRascunhos();
    });

    function atualizarDica(inputId, dicaId) {
        const v = parseInt($(inputId).value, 10);
        $(dicaId).textContent = v > 0 ? `(= ${fmtMin(v)})` : "";
    }
    $("atv-prevista").addEventListener("input", () => atualizarDica("atv-prevista", "atv-prevista-fmt"));
    $("atv-realizada").addEventListener("input", () => atualizarDica("atv-realizada", "atv-realizada-fmt"));

    $("btn-add-atividade").addEventListener("click", () => {
        const descricao = $("atv-descricao").value.trim();
        if (!descricao) {
            toast("Descreva a atividade antes de adicionar.", "aviso");
            $("atv-descricao").focus();
            return;
        }
        const prevista = parseInt($("atv-prevista").value || "0", 10);
        const realizada = parseInt($("atv-realizada").value || "0", 10);
        if (isNaN(prevista) || prevista < 0 || isNaN(realizada) || realizada < 0) {
            toast("Informe durações válidas, em minutos.", "aviso");
            return;
        }

        rascunhos.push({
            projeto_id: Number($("atv-projeto").value) || null,
            tipo_atividade_id: Number($("atv-tipo").value) || null,
            descricao_atividade: descricao,
            prioridade_dia: Number($("atv-prioridade").value) || 1,
            duracao_prevista_minutos: prevista,
            duracao_realizada_minutos: realizada,
            intercorrencias: $("atv-intercorrencias").value.trim() || null
        });

        $("atv-descricao").value = "";
        $("atv-prevista").value = "";
        $("atv-realizada").value = "";
        $("atv-intercorrencias").value = "";
        atualizarDica("atv-prevista", "atv-prevista-fmt");
        atualizarDica("atv-realizada", "atv-realizada-fmt");
        renderRascunhos();
        $("atv-descricao").focus();
    });

    // ---------------------------------------------------------------
    // Dia selecionado
    // ---------------------------------------------------------------
    function limparHorarios() {
        [1, 2, 3].forEach((n) => { $(`ponto-entrada-${n}`).value = ""; $(`ponto-saida-${n}`).value = ""; });
    }

    function mostrarStatusDia(texto, classes) {
        const el = $("dia-status");
        if (!texto) { el.classList.add("hidden"); return; }
        el.textContent = texto;
        el.className = `px-2.5 py-1 text-xs rounded-full ${classes}`;
    }

    async function carregarDia(data) {
        if (!data || !usuario) return;
        const minhaReq = ++reqDia;

        const { data: ponto, error } = await sb.from("apontamentos_ponto")
            .select("*, apontamentos_atividades(id, status_aprovacao, duracao_realizada_minutos)")
            .eq("usuario_id", usuario.id).eq("data", data).maybeSingle();
        if (minhaReq !== reqDia) return;

        if (error) {
            toast("Não foi possível carregar o dia: " + msgErro(error), "erro");
            return;
        }

        pontoDoDia = ponto ? { ...ponto, atividades: ponto.apontamentos_atividades || [] } : null;
        limparHorarios();

        if (ponto) {
            $("ponto-modalidade").value = ponto.modalidade;
            [1, 2, 3].forEach((n) => {
                $(`ponto-entrada-${n}`).value = hhmm(ponto[`entrada_${n}`]);
                $(`ponto-saida-${n}`).value = hhmm(ponto[`saida_${n}`]);
            });
            if (ponto.registro_travado) {
                mostrarStatusDia("Dia travado pelo gestor", "bg-red-900 text-red-300");
            } else {
                mostrarStatusDia("Dia já lançado — ao confirmar, os horários serão atualizados", "bg-sky-900 text-sky-300");
            }
        } else {
            mostrarStatusDia("");
        }

        $("btn-confirmar").disabled = !!(ponto && ponto.registro_travado);
        atualizarTotais();
    }

    $("ponto-data").addEventListener("change", () => carregarDia($("ponto-data").value));
    [1, 2, 3].forEach((n) => {
        $(`ponto-entrada-${n}`).addEventListener("input", atualizarTotais);
        $(`ponto-saida-${n}`).addEventListener("input", atualizarTotais);
    });

    $("btn-descartar").addEventListener("click", async () => {
        rascunhos = [];
        ["atv-descricao", "atv-prevista", "atv-realizada", "atv-intercorrencias"].forEach((id) => { $(id).value = ""; });
        renderRascunhos();
        await carregarDia($("ponto-data").value);
        toast("Alterações descartadas.", "aviso");
    });

    // ---------------------------------------------------------------
    // Confirmar lançamento
    // ---------------------------------------------------------------
    $("btn-confirmar").addEventListener("click", async () => {
        if (salvando) return;

        const data = $("ponto-data").value;
        if (!data) return toast("Selecione a data.", "aviso");

        const h = lerHorarios();
        if (h.erro) return toast(h.erro, "aviso");

        if ($("atv-descricao").value.trim()) {
            return toast("Há uma atividade digitada que ainda não foi adicionada. Clique em “Adicionar atividade” ou limpe o campo.", "aviso");
        }

        salvando = true;
        const btn = $("btn-confirmar");
        btn.disabled = true;
        btn.textContent = "Salvando…";

        try {
            const payload = {
                usuario_id: usuario.id,
                data,
                modalidade: $("ponto-modalidade").value,
                total_diario_horas: Math.round((h.minutos / 60) * 100) / 100,
                atualizado_em: new Date().toISOString()
            };
            h.pares.forEach((p) => {
                payload[`entrada_${p.n}`] = p.e || null;
                payload[`saida_${p.n}`] = p.s || null;
            });

            const { data: ponto, error } = await sb.from("apontamentos_ponto")
                .upsert(payload, { onConflict: "usuario_id,data" })
                .select().single();
            if (error) {
                toast(msgErro(error), "erro");
                return;
            }

            if (rascunhos.length) {
                const linhas = rascunhos.map((a) => ({ ...a, usuario_id: usuario.id, ponto_id: ponto.id, data }));
                const { error: erroAtv } = await sb.from("apontamentos_atividades").insert(linhas);
                if (erroAtv) {
                    toast("Ponto salvo, mas as atividades não foram gravadas: " + msgErro(erroAtv), "erro");
                    await Promise.all([carregarDia(data), carregarLancamentos()]);
                    return;
                }
            }

            rascunhos = [];
            renderRascunhos();
            toast(`Lançamento de ${fmtData(data)} confirmado.`);
            await Promise.all([carregarDia(data), carregarLancamentos()]);
        } finally {
            salvando = false;
            btn.textContent = "Confirmar lançamento";
            btn.disabled = !!(pontoDoDia && pontoDoDia.registro_travado);
        }
    });

    // ---------------------------------------------------------------
    // Meus lançamentos (histórico) com exclusão
    // ---------------------------------------------------------------
    const STATUS_CORES = {
        "Pendente": "bg-amber-900 text-amber-300",
        "Aprovado Integral": "bg-emerald-900 text-emerald-300",
        "Aprovado Parcial": "bg-sky-900 text-sky-300",
        "Glosado/Rejeitado": "bg-red-900 text-red-300"
    };

    async function carregarLancamentos() {
        if (!usuario) return;
        const desde = new Date();
        desde.setDate(desde.getDate() - 60);

        const { data, error } = await sb.from("apontamentos_ponto")
            .select("*, apontamentos_atividades(*, projetos(nome_projeto), tipos_atividade(nome))")
            .eq("usuario_id", usuario.id)
            .gte("data", dataISO(desde))
            .order("data", { ascending: false });

        if (error) {
            $("lancamentos-lista").innerHTML = `<p class="text-sm text-red-400">Não foi possível carregar seus lançamentos: ${esc(msgErro(error))}</p>`;
            return;
        }
        renderLancamentos(data || []);
    }

    function renderLancamentos(lista) {
        const box = $("lancamentos-lista");
        if (!lista.length) {
            box.innerHTML = `<p class="text-sm text-gray-500">Você ainda não tem lançamentos nos últimos 60 dias.</p>`;
            return;
        }

        box.innerHTML = lista.map((p) => {
            const atv = (p.apontamentos_atividades || [])
                .slice().sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
            const avaliado = atv.some((a) => a.registro_travado || a.status_aprovacao !== "Pendente");
            const diaTravado = !!p.registro_travado || avaliado;
            const periodos = [1, 2, 3]
                .filter((n) => p[`entrada_${n}`] && p[`saida_${n}`])
                .map((n) => `${hhmm(p[`entrada_${n}`])}–${hhmm(p[`saida_${n}`])}`).join(" · ");
            const minAtv = atv.reduce((s, a) => s + (a.duracao_realizada_minutos || 0), 0);

            const linhasAtv = atv.length ? atv.map((a) => {
                const podeExcluir = !a.registro_travado && a.status_aprovacao === "Pendente";
                return `
                <div class="flex items-start justify-between gap-3 py-3 border-t border-gray-700">
                    <div class="min-w-0">
                        <p class="text-sm text-gray-100 break-words">${esc(a.descricao_atividade)}</p>
                        <p class="text-xs text-gray-400 mt-1">${esc((a.projetos || {}).nome_projeto || "Sem projeto")} · ${esc((a.tipos_atividade || {}).nome || "Sem tipo")} · ${fmtMin(a.duracao_realizada_minutos)} realizadas${a.status_aprovacao !== "Pendente" ? ` · aprovadas ${fmtMin(a.duracao_aprovada_minutos)}` : ""}</p>
                        ${a.intercorrencias ? `<p class="text-xs text-amber-300 mt-1">Intercorrência: ${esc(a.intercorrencias)}</p>` : ""}
                        ${a["motivo_nao_aprovação"] ? `<p class="text-xs text-red-300 mt-1">Motivo: ${esc(a["motivo_nao_aprovação"])}</p>` : ""}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="px-2 py-0.5 text-xs rounded-full ${STATUS_CORES[a.status_aprovacao] || "bg-gray-700 text-gray-300"}">${esc(a.status_aprovacao)}</span>
                        ${podeExcluir ? `<button type="button" data-excluir-atv="${a.id}" data-desc="${esc(a.descricao_atividade)}" class="text-xs px-2.5 py-1 rounded-md bg-red-700 hover:bg-red-600 text-white">Excluir</button>` : ""}
                    </div>
                </div>`;
            }).join("") : `<p class="text-xs text-gray-500 py-3 border-t border-gray-700">Sem atividades neste dia.</p>`;

            return `
            <article class="border border-gray-700 rounded-xl px-4 pt-4 bg-gray-900/40">
                <div class="flex flex-wrap items-start justify-between gap-3 pb-3">
                    <div>
                        <p class="font-semibold text-gray-100">${fmtData(p.data)}</p>
                        <p class="text-xs text-gray-400 mt-1">${esc(p.modalidade)} · ${esc(periodos || "sem horários")} · ponto ${fmtMin(Number(p.total_diario_horas) * 60)} · atividades ${fmtMin(minAtv)}</p>
                    </div>
                    <div class="flex items-center gap-2">
                        ${diaTravado ? `<span class="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-300" title="Já avaliado ou travado pelo gestor">Em avaliação / travado</span>` : ""}
                        ${!p.registro_travado ? `<button type="button" data-editar="${p.data}" class="text-xs px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-100">Editar</button>` : ""}
                        ${!diaTravado ? `<button type="button" data-excluir-dia="${p.id}" data-data="${p.data}" data-qtd="${atv.length}" class="text-xs px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white">Excluir dia</button>` : ""}
                    </div>
                </div>
                ${linhasAtv}
            </article>`;
        }).join("");
    }

    $("lancamentos-lista").addEventListener("click", async (e) => {
        const editar = e.target.closest("[data-editar]");
        const excluirAtv = e.target.closest("[data-excluir-atv]");
        const excluirDia = e.target.closest("[data-excluir-dia]");

        if (editar) {
            $("ponto-data").value = editar.dataset.editar;
            await carregarDia(editar.dataset.editar);
            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
        }

        if (excluirAtv) {
            const ok = await confirmarModal({
                titulo: "Excluir atividade?",
                texto: `“${excluirAtv.dataset.desc}” será excluída permanentemente.`
            });
            if (!ok) return;

            const { data, error } = await sb.from("apontamentos_atividades")
                .delete().eq("id", excluirAtv.dataset.excluirAtv).select("id");
            if (error) return toast(msgErro(error), "erro");
            if (!data || !data.length) return toast("Não foi possível excluir: a atividade já foi avaliada ou travada pelo gestor.", "erro");

            toast("Atividade excluída.");
            await Promise.all([carregarLancamentos(), carregarDia($("ponto-data").value)]);
            return;
        }

        if (excluirDia) {
            const qtd = Number(excluirDia.dataset.qtd || 0);
            const ok = await confirmarModal({
                titulo: "Excluir dia inteiro?",
                texto: `O lançamento de ${fmtData(excluirDia.dataset.data)}${qtd ? ` e ${qtd === 1 ? "a 1 atividade" : `as ${qtd} atividades`}` : ""} será excluído permanentemente.`,
                botao: "Excluir dia"
            });
            if (!ok) return;

            const { error } = await sb.rpc("excluir_ponto_dia", { p_ponto_id: excluirDia.dataset.excluirDia });
            if (error) return toast(msgErro(error), "erro");

            toast("Dia excluído.");
            await Promise.all([carregarLancamentos(), carregarDia($("ponto-data").value)]);
        }
    });

    // ---------------------------------------------------------------
    // Mantém a sessão ao recarregar a página
    // ---------------------------------------------------------------
    if (sb) {
        sb.auth.getSession().then(({ data }) => {
            if (data && data.session) carregarApp(data.session.user);
        });
    }
});
