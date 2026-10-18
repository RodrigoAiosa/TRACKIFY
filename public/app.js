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
        if (/duplicate key|projetos_nome/i.test(m)) return "Já existe um projeto com esse nome.";
        if (/rate limit/i.test(m)) return "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.";
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
    let modoAdm = false;
    $("btn-login-adm").addEventListener("click", () => {
        modoAdm = !modoAdm;
        const campo = $("login-email");
        campo.type = modoAdm ? "text" : "email";
        campo.value = "";
        campo.autocomplete = modoAdm ? "username" : "email";
        $("login-email-label").textContent = modoAdm ? "Usuário ADM" : "E-mail";
        $("btn-login-adm").textContent = modoAdm ? "Voltar ao login com e-mail" : "Entrar como ADM do sistema";
        campo.focus();
    });
    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (!sb) return toast("Erro ao conectar ao banco de dados.", "erro");

            let email = $("login-email").value.trim();
            const password = $("login-password").value;
            if (modoAdm) {
                const r = await sb.rpc("email_do_admin", { p_usuario: email });
                if (r.error || !r.data) return toast("Usuário ou senha incorretos.", "erro");
                email = r.data;
            }
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
            if (ehGestor()) {
                const tabAprovacao = $("tab-aprovação");
                if (tabAprovacao) tabAprovacao.classList.remove("hidden");
                $("tab-projetos").classList.remove("hidden");
                if (perfil.role === "admin") {
                    $("tab-equipe").classList.remove("hidden");
                    $("tab-relatorios").classList.remove("hidden");
                }
                atualizarPendentes();
            }
        }
        ativarAba("ponto");

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
    // Abas
    // ---------------------------------------------------------------
    const ehGestor = () => !!perfil && (perfil.role === "gestor" || perfil.role === "admin");
    let gestorIniciado = false;

    function ativarAba(qual) {
        const colab = qual === "ponto";
        const gest = qual === "gestor";
        const proj = qual === "projetos";
        const eqp = qual === "equipe";
        const rel = qual === "relatorios";
        $("view-relatorios").classList.toggle("hidden", !rel);
        $("view-equipe").classList.toggle("hidden", !eqp);
        $("view-colaborador").classList.toggle("hidden", !colab);
        $("view-gestor").classList.toggle("hidden", !gest);
        $("view-projetos").classList.toggle("hidden", !proj);

        const ativa = ["border-emerald-500", "text-emerald-400", "font-semibold"];
        const inativa = ["border-transparent", "text-gray-400", "hover:text-gray-200"];
        const marca = (btn, ligado) => {
            ativa.forEach((c) => btn.classList.toggle(c, ligado));
            inativa.forEach((c) => btn.classList.toggle(c, !ligado));
        };
        marca($("tab-ponto"), colab);
        marca($("tab-aprovação"), gest);
        marca($("tab-projetos"), proj);
        marca($("tab-equipe"), eqp);
        marca($("tab-relatorios"), rel);

        if (gest && ehGestor()) iniciarGestor();
        if (proj && ehGestor()) carregarProjetos();
        if (eqp && perfil && perfil.role === "admin") carregarEquipe();
        if (rel && perfil && perfil.role === "admin") iniciarRelatorios();
    }
    $("tab-ponto").addEventListener("click", () => ativarAba("ponto"));
    $("tab-aprovação").addEventListener("click", () => ativarAba("gestor"));
    $("tab-projetos").addEventListener("click", () => ativarAba("projetos"));
    $("tab-equipe").addEventListener("click", () => ativarAba("equipe"));
    $("tab-relatorios").addEventListener("click", () => ativarAba("relatorios"));

    // ---------------------------------------------------------------
    // Relatórios de gestão (somente ADM)
    // ---------------------------------------------------------------
    const STATUS_REL = ["Pendente", "Aprovado Integral", "Aprovado Parcial", "Glosado/Rejeitado"];
    let relIniciado = false;
    let relTabelas = [];   // tabelas do último relatório (para exportar CSV)

    async function paginar(montar) {
        let todos = [], de = 0;
        for (;;) {
            const { data, error } = await montar().range(de, de + 999);
            if (error) throw error;
            todos = todos.concat(data || []);
            if (!data || data.length < 1000) break;
            de += 1000;
        }
        return todos;
    }

    function iniciarRelatorios() {
        if (!relIniciado) {
            relIniciado = true;
            const hoje = new Date();
            $("rel-de").value = dataISO(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
            $("rel-ate").value = dataISO(hoje);
        }
        carregarRelatorios();
    }

    // célula: valor simples, ou [valorCSV, texto, percentualDaBarra?]
    const dec = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
    const H = (min) => [dec((min || 0) / 60), fmtMin(min || 0)];
    const PCT = (n, d) => (d > 0 ? [dec((n / d) * 100), `${Math.round((n / d) * 100)}%`] : ["", "—"]);
    const txt = (c) => (Array.isArray(c) ? c[1] : c);
    const csvVal = (c) => (Array.isArray(c) ? c[0] : c);

    function tabelaRel(titulo, colunas, linhas, nota) {
        const idx = relTabelas.length;
        relTabelas.push({ titulo, colunas, linhas });
        const th = colunas.map((c, i) => `<th class="py-2 pr-4 font-medium ${i ? "text-right" : "text-left"}">${esc(c)}</th>`).join("");
        const tr = linhas.length ? linhas.map((l) => `<tr class="border-t border-gray-700">${l.map((c, i) => {
            const bar = Array.isArray(c) && c[2] != null
                ? `<div class="mt-1 h-1.5 bg-gray-700 rounded"><div class="h-1.5 bg-emerald-500 rounded" style="width:${Math.max(0, Math.min(100, c[2]))}%"></div></div>` : "";
            return `<td class="py-2 pr-4 ${i ? "text-right tabular-nums" : "text-left"} text-gray-200">${esc(txt(c))}${bar}</td>`;
        }).join("")}</tr>`).join("")
            : `<tr><td colspan="${colunas.length}" class="py-3 text-gray-500">Sem dados no período.</td></tr>`;
        return `<div class="bg-gray-800 p-6 rounded-xl border border-gray-700" data-rel="${idx}">
            <div class="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h3 class="text-base font-semibold text-emerald-400">${esc(titulo)}</h3>
                <button type="button" data-csv="${idx}" class="text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-100">Exportar CSV</button>
            </div>
            ${nota ? `<p class="text-xs text-gray-500 mb-2">${esc(nota)}</p>` : ""}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-xs text-gray-400"><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>
        </div>`;
    }

    function baixarCSV(nome, colunas, linhas) {
        const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const corpo = [colunas.map(q).join(";")].concat(linhas.map((l) => l.map((c) => q(csvVal(c))).join(";"))).join("\r\n");
        const blob = new Blob(["\ufeff" + corpo], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function diasUteis(de, ate) {
        const out = [];
        for (let d = new Date(de + "T12:00:00"); dataISO(d) <= ate; d.setDate(d.getDate() + 1)) {
            if (d.getDay() !== 0 && d.getDay() !== 6) out.push(dataISO(d));
        }
        return out;
    }

    async function carregarRelatorios() {
        const alvo = $("rel-conteudo");
        const de = $("rel-de").value, ate = $("rel-ate").value;
        if (!de || !ate || de > ate) { alvo.innerHTML = '<p class="text-sm text-red-400">Informe um período válido (De deve ser anterior a Até).</p>'; return; }
        alvo.innerHTML = '<p class="text-sm text-gray-400">Carregando relatórios…</p>';

        let perfis, pontos, atvs, projs, tps;
        try {
            [perfis, pontos, atvs, projs, tps] = await Promise.all([
                paginar(() => sb.from("perfis").select("id, nome_completo, email, role, gestor_id").order("nome_completo").order("id")),
                paginar(() => sb.from("apontamentos_ponto").select("*").gte("data", de).lte("data", ate).order("data").order("id")),
                paginar(() => sb.from("apontamentos_atividades").select("*").gte("data", de).lte("data", ate).order("data").order("id")),
                paginar(() => sb.from("projetos").select("id, nome_projeto").order("id")),
                paginar(() => sb.from("tipos_atividade").select("id, nome").order("id"))
            ]);
        } catch (err) {
            alvo.innerHTML = `<p class="text-sm text-red-400">Não foi possível carregar os dados: ${esc(msgErro(err))}</p>`;
            return;
        }

        // filtros (os seletores são reconstruídos a cada carga, preservando a escolha)
        const gerSel = $("rel-gerente").value, colSel = $("rel-colab").value;
        const gerentes = perfis.filter((x) => x.role === "gestor");
        $("rel-gerente").innerHTML = '<option value="">Todos</option><option value="__sem">Sem gerente</option>'
            + gerentes.map((g) => `<option value="${g.id}">${esc(g.nome_completo)}</option>`).join("");
        $("rel-gerente").value = gerentes.some((g) => g.id === gerSel) || gerSel === "__sem" ? gerSel : "";
        const doGerente = (u) => {
            const g = $("rel-gerente").value;
            return !g || (g === "__sem" ? !u.gestor_id : u.gestor_id === g);
        };
        $("rel-colab").innerHTML = '<option value="">Todos</option>'
            + perfis.filter((u) => u.role !== "admin" && doGerente(u)).map((u) => `<option value="${u.id}">${esc(u.nome_completo)}</option>`).join("");
        $("rel-colab").value = [...$("rel-colab").options].some((o) => o.value === colSel) ? colSel : "";
        const colFiltro = $("rel-colab").value;

        const nomeDe = new Map(perfis.map((u) => [u.id, u.nome_completo]));
        const gerenteDe = (uid) => {
            const u = perfis.find((x) => x.id === uid);
            return u && u.gestor_id ? (nomeDe.get(u.gestor_id) || "—") : "Sem gerente";
        };
        const usuarios = perfis.filter((u) => u.role !== "admin" && doGerente(u) && (!colFiltro || u.id === colFiltro));
        const ids = new Set(usuarios.map((u) => u.id));
        const P = pontos.filter((x) => ids.has(x.usuario_id));
        const A = atvs.filter((x) => ids.has(x.usuario_id));
        const nomeProj = new Map(projs.map((x) => [x.id, x.nome_projeto]));
        const nomeTipo = new Map(tps.map((x) => [x.id, x.nome]));
        const st = (a) => a.status_aprovacao || "Pendente";
        const min = (a, k) => Number(a[k]) || 0;
        const hojeISO = dataISO(new Date());

        relTabelas = [];
        const secoes = [];

        // ---------- KPIs ----------
        const trabalhadoMin = P.reduce((s, x) => s + Math.round((Number(x.total_diario_horas) || 0) * 60), 0);
        const realizadoMin = A.reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0);
        const aprovadoMin = A.reduce((s, a) => s + min(a, "duracao_aprovada_minutos"), 0);
        const avaliadoMin = A.filter((a) => st(a) !== "Pendente").reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0);
        const pendentes = A.filter((a) => st(a) === "Pendente");
        const kpis = [
            ["Colaboradores com lançamento", new Set(P.map((x) => x.usuario_id)).size + " de " + usuarios.length],
            ["Dias lançados", P.length],
            ["Horas trabalhadas", fmtMin(trabalhadoMin)],
            ["Horas em atividades", fmtMin(realizadoMin)],
            ["Horas aprovadas", fmtMin(aprovadoMin)],
            ["Aprovação das horas avaliadas", PCT(aprovadoMin, avaliadoMin)[1]],
            ["Atividades pendentes", `${pendentes.length} (${fmtMin(pendentes.reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0))})`],
            ["Atividades rejeitadas", A.filter((a) => st(a) === "Glosado/Rejeitado").length]
        ];
        secoes.push(`<div class="grid grid-cols-2 md:grid-cols-4 gap-3">${kpis.map(([r, v]) => `
            <div class="bg-gray-800 p-4 rounded-xl border border-gray-700"><div class="text-xs text-gray-400">${esc(r)}</div><div class="text-xl font-semibold text-gray-100 mt-1">${esc(v)}</div></div>`).join("")}</div>`);

        // ---------- Por colaborador ----------
        const porUser = usuarios.map((u) => {
            const pu = P.filter((x) => x.usuario_id === u.id), au = A.filter((x) => x.usuario_id === u.id);
            const trab = pu.reduce((s, x) => s + Math.round((Number(x.total_diario_horas) || 0) * 60), 0);
            const real = au.reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0);
            const apr = au.reduce((s, a) => s + min(a, "duracao_aprovada_minutos"), 0);
            const aval = au.filter((a) => st(a) !== "Pendente").reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0);
            const prev = au.reduce((s, a) => s + min(a, "duracao_prevista_minutos"), 0);
            const pend = au.filter((a) => st(a) === "Pendente");
            return { u, dias: pu.length, trab, real, apr, aval, prev, pend: pend.length, pendMin: pend.reduce((s, a) => s + min(a, "duracao_realizada_minutos"), 0), datas: new Set(pu.map((x) => x.data)) };
        });
        const maxTrab = Math.max(1, ...porUser.map((x) => x.trab));
        secoes.push(tabelaRel("Horas por colaborador",
            ["Colaborador", "Gerente", "Dias", "Trabalhadas", "Em atividades", "Aderência", "Aprovadas", "Aprovação", "Pendentes"],
            porUser.map((x) => [x.u.nome_completo, gerenteDe(x.u.id), x.dias, [H(x.trab)[0], fmtMin(x.trab), (x.trab / maxTrab) * 100],
                H(x.real), PCT(x.real, x.trab), H(x.apr), PCT(x.apr, x.aval), `${x.pend} (${fmtMin(x.pendMin)})`]),
            "Aderência = horas em atividades ÷ horas trabalhadas. Aprovação = horas aprovadas ÷ horas já avaliadas."));

        // ---------- Por gerente ----------
        const grupos = new Map();
        porUser.forEach((x) => {
            const g = gerenteDe(x.u.id);
            const o = grupos.get(g) || { n: 0, dias: 0, trab: 0, real: 0, apr: 0, aval: 0, pend: 0 };
            o.n++; o.dias += x.dias; o.trab += x.trab; o.real += x.real; o.apr += x.apr; o.aval += x.aval; o.pend += x.pend;
            grupos.set(g, o);
        });
        secoes.push(tabelaRel("Horas por gerente (equipe)",
            ["Gerente", "Colaboradores", "Dias", "Trabalhadas", "Em atividades", "Aprovadas", "Aprovação", "Pendentes"],
            [...grupos.entries()].sort((a, b) => b[1].trab - a[1].trab).map(([g, o]) =>
                [g, o.n, o.dias, H(o.trab), H(o.real), H(o.apr), PCT(o.apr, o.aval), o.pend])));

        // ---------- Por projeto / tipo ----------
        const agrupar = (chave, nomes, semNome) => {
            const m = new Map();
            A.forEach((a) => {
                const n = nomes.get(a[chave]) || semNome;
                const o = m.get(n) || { q: 0, real: 0, apr: 0, aval: 0, prev: 0 };
                o.q++; o.real += min(a, "duracao_realizada_minutos"); o.apr += min(a, "duracao_aprovada_minutos");
                if (st(a) !== "Pendente") o.aval += min(a, "duracao_realizada_minutos");
                o.prev += min(a, "duracao_prevista_minutos");
                m.set(n, o);
            });
            const total = [...m.values()].reduce((s, o) => s + o.real, 0) || 1;
            return [...m.entries()].sort((a, b) => b[1].real - a[1].real).map(([n, o]) =>
                [n, o.q, [H(o.real)[0], fmtMin(o.real), (o.real / total) * 100], PCT(o.real, total), H(o.apr), PCT(o.apr, o.aval)]);
        };
        const colsAgr = (r) => [r, "Atividades", "Realizado", "% do total", "Aprovado", "Aprovação"];
        secoes.push(tabelaRel("Horas por projeto", colsAgr("Projeto"), agrupar("projeto_id", nomeProj, "Sem projeto")));
        secoes.push(tabelaRel("Horas por tipo de atividade", colsAgr("Tipo"), agrupar("tipo_atividade_id", nomeTipo, "Sem tipo")));

        // ---------- Projeto x colaborador ----------
        const pc = new Map();
        A.forEach((a) => {
            const k = `${nomeProj.get(a.projeto_id) || "Sem projeto"}\u0000${nomeDe.get(a.usuario_id) || "—"}`;
            pc.set(k, (pc.get(k) || 0) + min(a, "duracao_realizada_minutos"));
        });
        secoes.push(tabelaRel("Projeto × colaborador (horas realizadas)", ["Projeto", "Colaborador", "Horas"],
            [...pc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => { const [pr, co] = k.split("\u0000"); return [pr, co, H(v)]; })));

        // ---------- Situação das aprovações ----------
        secoes.push(tabelaRel("Situação das aprovações", ["Situação", "Atividades", "Horas realizadas", "Horas aprovadas"],
            STATUS_REL.map((s) => { const l = A.filter((a) => st(a) === s);
                return [s, l.length, H(l.reduce((t, a) => t + min(a, "duracao_realizada_minutos"), 0)), H(l.reduce((t, a) => t + min(a, "duracao_aprovada_minutos"), 0))]; })));

        // ---------- Previsto x realizado ----------
        secoes.push(tabelaRel("Previsto × realizado por colaborador", ["Colaborador", "Previsto", "Realizado", "Desvio"],
            porUser.filter((x) => x.prev || x.real).map((x) => [x.u.nome_completo, H(x.prev), H(x.real),
                x.prev ? [dec(((x.real - x.prev) / x.prev) * 100), `${x.real >= x.prev ? "+" : ""}${Math.round(((x.real - x.prev) / x.prev) * 100)}%`] : ["", "—"]]),
            "Desvio positivo = gastou mais tempo do que previu."));

        // ---------- Modalidade ----------
        const mod = new Map();
        P.forEach((x) => { const m = x.modalidade || "Não informada"; const o = mod.get(m) || { d: 0, h: 0 }; o.d++; o.h += Math.round((Number(x.total_diario_horas) || 0) * 60); mod.set(m, o); });
        secoes.push(tabelaRel("Presencial × remoto", ["Modalidade", "Dias", "Horas trabalhadas", "% dos dias"],
            [...mod.entries()].map(([m, o]) => [m, o.d, H(o.h), PCT(o.d, P.length)])));

        // ---------- Evolução diária ----------
        const dia = new Map();
        P.forEach((x) => { const o = dia.get(x.data) || { t: 0, r: 0, a: 0 }; o.t += Math.round((Number(x.total_diario_horas) || 0) * 60); dia.set(x.data, o); });
        A.forEach((a) => { const o = dia.get(a.data) || { t: 0, r: 0, a: 0 }; o.r += min(a, "duracao_realizada_minutos"); o.a += min(a, "duracao_aprovada_minutos"); dia.set(a.data, o); });
        const maxDia = Math.max(1, ...[...dia.values()].map((o) => o.t));
        secoes.push(tabelaRel("Evolução diária", ["Data", "Trabalhadas", "Em atividades", "Aprovadas"],
            [...dia.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, o]) => [fmtData(d), [H(o.t)[0], fmtMin(o.t), (o.t / maxDia) * 100], H(o.r), H(o.a)])));

        // ---------- Dias úteis sem lançamento ----------
        const uteis = diasUteis(de, ate < hojeISO ? ate : hojeISO);
        secoes.push(tabelaRel("Dias úteis sem lançamento", ["Colaborador", "Gerente", "Dias úteis", "Lançados", "Sem lançamento"],
            porUser.map((x) => { const sem = uteis.filter((d) => !x.datas.has(d)).length; return [x.u.nome_completo, gerenteDe(x.u.id), uteis.length, x.dias, sem]; })
                .sort((a, b) => b[4] - a[4]),
            "Considera segunda a sexta até hoje; feriados e folgas não são descontados."));

        // ---------- Pendências por idade ----------
        const faixas = [["0–2 dias", 0, 2], ["3–7 dias", 3, 7], ["8–14 dias", 8, 14], ["15+ dias", 15, 1e9]];
        const idade = (d) => Math.max(0, Math.round((new Date(hojeISO + "T12:00:00") - new Date(d + "T12:00:00")) / 86400000));
        const pg = new Map();
        pendentes.forEach((a) => {
            const g = gerenteDe(a.usuario_id); const o = pg.get(g) || faixas.map(() => 0);
            const i = faixas.findIndex((f) => idade(a.data) >= f[1] && idade(a.data) <= f[2]); o[i]++; pg.set(g, o);
        });
        secoes.push(tabelaRel("Pendências de aprovação por idade", ["Gerente", ...faixas.map((f) => f[0]), "Total"],
            [...pg.entries()].map(([g, o]) => [g, ...o, o.reduce((s, n) => s + n, 0)])));

        // ---------- Rejeições e intercorrências ----------
        secoes.push(tabelaRel("Atividades rejeitadas (com motivo)", ["Data", "Colaborador", "Projeto", "Atividade", "Horas", "Motivo"],
            A.filter((a) => st(a) === "Glosado/Rejeitado").map((a) => [fmtData(a.data), nomeDe.get(a.usuario_id) || "—",
                nomeProj.get(a.projeto_id) || "Sem projeto", a.descricao_atividade || "", H(min(a, "duracao_realizada_minutos")), a["motivo_nao_aprovação"] || ""])));
        secoes.push(tabelaRel("Intercorrências registradas", ["Data", "Colaborador", "Projeto", "Intercorrência"],
            A.filter((a) => (a.intercorrencias || "").trim()).map((a) => [fmtData(a.data), nomeDe.get(a.usuario_id) || "—", nomeProj.get(a.projeto_id) || "Sem projeto", a.intercorrencias])));

        alvo.innerHTML = secoes.join("");
    }

    $("rel-atualizar").addEventListener("click", carregarRelatorios);
    ["rel-gerente", "rel-colab", "rel-de", "rel-ate"].forEach((id) => $(id).addEventListener("change", carregarRelatorios));
    $("rel-conteudo").addEventListener("click", (e) => {
        const b = e.target.closest("[data-csv]");
        if (!b) return;
        const t = relTabelas[Number(b.dataset.csv)];
        if (t) baixarCSV(t.titulo, t.colunas, t.linhas);
    });
    $("rel-exportar-tudo").addEventListener("click", () => {
        if (!relTabelas.length) return toast("Nada para exportar ainda.", "aviso");
        relTabelas.forEach((t, i) => setTimeout(() => baixarCSV(`${String(i + 1).padStart(2, "0")} ${t.titulo}`, t.colunas, t.linhas), i * 250));
    });

    // ---------------------------------------------------------------
    // Equipe (somente ADM): define gerentes e a equipe de cada um
    // ---------------------------------------------------------------
    async function carregarEquipe() {
        const lista = $("equipe-lista");
        const { data, error } = await sb.from("perfis")
            .select("id, nome_completo, email, role, gestor_id").order("nome_completo");
        if (error) { lista.innerHTML = `<p class="text-sm text-red-400">${esc(msgErro(error))}</p>`; return; }
        const todos = data || [];
        const gerentes = todos.filter((x) => x.role === "gestor");
        const rotulo = { colaborador: "Colaborador", gestor: "Gerente", admin: "ADM" };
        const sel = "p-1.5 bg-gray-700 border border-gray-600 rounded-md text-sm text-white";
        lista.innerHTML = todos.map((u) => {
            if (u.role === "admin") {
                return `<div class="flex flex-wrap items-center justify-between gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700">
                    <div><div class="font-medium text-gray-100">${esc(u.nome_completo)}</div><div class="text-xs text-gray-400">${esc(u.email)}</div></div>
                    <span class="text-xs px-2 py-0.5 rounded-full bg-purple-900 text-purple-300">${rotulo.admin}</span></div>`;
            }
            const opGer = ['<option value="">Sem gerente</option>']
                .concat(gerentes.filter((g) => g.id !== u.id).map((g) =>
                    `<option value="${g.id}" ${g.id === u.gestor_id ? "selected" : ""}>${esc(g.nome_completo)}</option>`)).join("");
            return `<div class="flex flex-wrap items-center justify-between gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700" data-u="${u.id}">
                <div class="min-w-0"><div class="font-medium text-gray-100">${esc(u.nome_completo)}</div><div class="text-xs text-gray-400">${esc(u.email)}</div></div>
                <div class="flex flex-wrap items-center gap-2">
                    <select data-f="role" class="${sel}">
                        <option value="colaborador" ${u.role === "colaborador" ? "selected" : ""}>Colaborador</option>
                        <option value="gestor" ${u.role === "gestor" ? "selected" : ""}>Gerente</option>
                    </select>
                    <select data-f="gestor" class="${sel} ${u.role === "gestor" ? "hidden" : ""}">${opGer}</select>
                    <button type="button" data-eq-salvar class="px-3 py-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Salvar</button>
                </div></div>`;
        }).join("") || '<p class="text-sm text-gray-500">Nenhum usuário cadastrado.</p>';
    }

    $("equipe-lista").addEventListener("change", (e) => {
        if (e.target.dataset.f !== "role") return;
        const linha = e.target.closest("[data-u]");
        linha.querySelector('[data-f="gestor"]').classList.toggle("hidden", e.target.value === "gestor");
    });

    $("equipe-lista").addEventListener("click", async (e) => {
        const b = e.target.closest("[data-eq-salvar]");
        if (!b) return;
        const linha = b.closest("[data-u]");
        const funcao = linha.querySelector('[data-f="role"]').value;
        const gerente = linha.querySelector('[data-f="gestor"]').value || null;
        b.disabled = true;
        const { error } = await sb.rpc("admin_definir_perfil", {
            p_usuario: linha.dataset.u, p_role: funcao, p_gestor: funcao === "gestor" ? null : gerente
        });
        b.disabled = false;
        if (error) { toast(msgErro(error), "erro"); return; }
        toast("Perfil atualizado.");
        carregarEquipe();
    });

    // ---------------------------------------------------------------
    // Projetos (gestor/admin)
    // ---------------------------------------------------------------
    async function carregarProjetos() {
        const lista = $("projetos-lista");
        const { data, error } = await sb.from("projetos")
            .select("id, nome_projeto, descricao, ativo").order("nome_projeto");
        if (error) {
            lista.innerHTML = `<p class="text-sm text-red-400">${esc(msgErro(error))}</p>`;
            return;
        }
        const itens = data || [];
        const ativos = itens.filter((x) => x.ativo).length;
        $("projetos-resumo").textContent = itens.length
            ? `${itens.length} projeto(s) · ${ativos} ativo(s)` : "";
        if (!itens.length) {
            lista.innerHTML = '<p class="text-sm text-gray-500">Nenhum projeto cadastrado ainda. Use o formulário acima.</p>';
            return;
        }
        lista.innerHTML = itens.map((x) => `
            <div class="flex flex-wrap items-center justify-between gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700">
                <div class="min-w-0">
                    <div class="font-medium ${x.ativo ? "text-gray-100" : "text-gray-500 line-through"}">${esc(x.nome_projeto)}</div>
                    ${x.descricao ? `<div class="text-xs text-gray-400">${esc(x.descricao)}</div>` : ""}
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs px-2 py-0.5 rounded-full ${x.ativo ? "bg-emerald-900 text-emerald-300" : "bg-gray-700 text-gray-400"}">${x.ativo ? "Ativo" : "Inativo"}</span>
                    <button type="button" data-proj-toggle="${x.id}" data-ativo="${x.ativo ? "1" : "0"}" class="px-3 py-1 text-xs rounded-md bg-gray-700 hover:bg-gray-600 text-gray-100">${x.ativo ? "Inativar" : "Ativar"}</button>
                </div>
            </div>`).join("");
    }

    $("projeto-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const nome = $("projeto-nome").value.replace(/\s+/g, " ").trim();
        const descricao = $("projeto-descricao").value.trim();
        if (!nome) { toast("Informe o nome do projeto.", "erro"); return; }
        const btn = $("projeto-salvar");
        btn.disabled = true;
        try {
            const { error } = await sb.from("projetos")
                .insert({ nome_projeto: nome, descricao: descricao || null });
            if (error) { toast(msgErro(error), "erro"); return; }
            $("projeto-form").reset();
            toast("Projeto cadastrado.");
            await Promise.all([carregarProjetos(), carregarApoio()]);
        } finally {
            btn.disabled = false;
        }
    });

    $("projetos-lista").addEventListener("click", async (e) => {
        const b = e.target.closest("[data-proj-toggle]");
        if (!b) return;
        const id = Number(b.dataset.projToggle);
        const novo = b.dataset.ativo !== "1";
        b.disabled = true;
        const { data, error } = await sb.from("projetos").update({ ativo: novo }).eq("id", id).select("id");
        if (error || !data || !data.length) {
            toast(error ? msgErro(error) : "Operação não permitida.", "erro");
            b.disabled = false;
            return;
        }
        toast(novo ? "Projeto ativado." : "Projeto inativado.");
        await Promise.all([carregarProjetos(), carregarApoio()]);
    });

    // ---------------------------------------------------------------
    // Aprovação (gerência)
    // ---------------------------------------------------------------
    let gDados = [];
    let avaliando = null;   // atividade aberta no modal Ajustar/Rejeitar

    async function atualizarPendentes() {
        const { count } = await sb.from("apontamentos_atividades")
            .select("id", { count: "exact", head: true })
            .eq("status_aprovacao", "Pendente")
            .neq("usuario_id", usuario.id);
        const badge = $("tab-pendentes");
        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove("hidden");
        } else {
            badge.classList.add("hidden");
        }
    }

    async function iniciarGestor() {
        if (!gestorIniciado) {
            gestorIniciado = true;
            const hoje = new Date();
            const ini = new Date();
            ini.setDate(ini.getDate() - 30);
            $("g-de").value = dataISO(ini);
            $("g-ate").value = dataISO(hoje);

            const { data: equipe } = await sb.from("perfis")
                .select("id, nome_completo").neq("id", usuario.id).order("nome_completo");
            $("g-colab").innerHTML = `<option value="">Todos</option>` +
                (equipe || []).map((x) => `<option value="${x.id}">${esc(x.nome_completo)}</option>`).join("");
        }
        await carregarGestor();
    }

    async function carregarGestor() {
        let q = sb.from("apontamentos_ponto")
            .select("*, perfis(nome_completo), apontamentos_atividades(*, projetos(nome_projeto), tipos_atividade(nome))")
            .neq("usuario_id", usuario.id)
            .order("data", { ascending: false });
        if ($("g-de").value) q = q.gte("data", $("g-de").value);
        if ($("g-ate").value) q = q.lte("data", $("g-ate").value);
        if ($("g-colab").value) q = q.eq("usuario_id", $("g-colab").value);

        const { data, error } = await q;
        if (error) {
            $("g-lista").innerHTML = `<p class="text-sm text-red-400">Não foi possível carregar os lançamentos: ${esc(msgErro(error))}</p>`;
            return;
        }
        gDados = data || [];
        renderGestor();
        atualizarPendentes();
    }

    function renderGestor() {
        const filtro = $("g-status").value;
        const ehPend = (a) => a.status_aprovacao === "Pendente";

        // resumo geral do período
        let pend = 0, apr = 0, rej = 0, minPend = 0;
        gDados.forEach((p) => (p.apontamentos_atividades || []).forEach((a) => {
            if (ehPend(a)) { pend++; minPend += a.duracao_realizada_minutos || 0; }
            else if (a.status_aprovacao === "Glosado/Rejeitado") rej++;
            else apr++;
        }));
        $("g-resumo").textContent = `${pend} pendente(s) (${fmtMin(minPend)}) · ${apr} aprovada(s) · ${rej} rejeitada(s)`;

        const dias = gDados.filter((p) => {
            const atv = p.apontamentos_atividades || [];
            if (filtro === "pendentes") return atv.some(ehPend);
            if (filtro === "avaliadas") return atv.some((a) => !ehPend(a));
            return true;
        });

        const box = $("g-lista");
        if (!dias.length) {
            box.innerHTML = `<p class="text-sm text-gray-500">Nenhum lançamento encontrado para os filtros escolhidos.</p>`;
            return;
        }

        box.innerHTML = dias.map((p) => {
            const atv = (p.apontamentos_atividades || [])
                .slice().sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
            const qtdPend = atv.filter(ehPend).length;
            const periodos = [1, 2, 3]
                .filter((n) => p[`entrada_${n}`] && p[`saida_${n}`])
                .map((n) => `${hhmm(p[`entrada_${n}`])}–${hhmm(p[`saida_${n}`])}`).join(" · ");
            const minAtv = atv.reduce((s, a) => s + (a.duracao_realizada_minutos || 0), 0);
            const minApr = atv.reduce((s, a) => s + (a.duracao_aprovada_minutos || 0), 0);

            const linhas = atv.map((a) => {
                const integral = a.status_aprovacao === "Aprovado Integral";
                let detalhe = "";
                if (a.status_aprovacao === "Aprovado Parcial") detalhe = ` · aprovado ${fmtMin(a.duracao_aprovada_minutos)} de ${fmtMin(a.duracao_realizada_minutos)}`;
                return `
                <div class="flex items-start justify-between gap-3 py-3 border-t border-gray-700">
                    <label class="flex items-start gap-3 min-w-0 cursor-pointer">
                        <input type="checkbox" data-check="${a.id}" data-status="${esc(a.status_aprovacao)}" ${integral ? "checked" : ""}
                               class="mt-1 h-5 w-5 shrink-0 accent-emerald-500 cursor-pointer" aria-label="Aprovar atividade">
                        <span class="min-w-0">
                            <span class="block text-sm text-gray-100 break-words">${esc(a.descricao_atividade)}</span>
                            <span class="block text-xs text-gray-400 mt-1">${esc((a.projetos || {}).nome_projeto || "Sem projeto")} · ${esc((a.tipos_atividade || {}).nome || "Sem tipo")} · ${fmtMin(a.duracao_realizada_minutos)} realizadas (previstas ${fmtMin(a.duracao_prevista_minutos)})${detalhe}</span>
                            ${a.intercorrencias ? `<span class="block text-xs text-amber-300 mt-1">Intercorrência: ${esc(a.intercorrencias)}</span>` : ""}
                            ${a["motivo_nao_aprovação"] ? `<span class="block text-xs text-red-300 mt-1">Motivo: ${esc(a["motivo_nao_aprovação"])}</span>` : ""}
                        </span>
                    </label>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="px-2 py-0.5 text-xs rounded-full ${STATUS_CORES[a.status_aprovacao] || "bg-gray-700 text-gray-300"}">${esc(a.status_aprovacao)}</span>
                        <button type="button" data-ajustar="${a.id}" data-desc="${esc(a.descricao_atividade)}" data-realizado="${a.duracao_realizada_minutos || 0}"
                                class="text-xs px-2.5 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-100">Ajustar / Rejeitar</button>
                    </div>
                </div>`;
            }).join("");

            return `
            <article class="border border-gray-700 rounded-xl px-4 pt-4 bg-gray-900/40">
                <div class="flex flex-wrap items-start justify-between gap-3 pb-3">
                    <div>
                        <p class="font-semibold text-gray-100">${esc((p.perfis || {}).nome_completo || "Colaborador")} <span class="text-gray-400 font-normal">— ${fmtData(p.data)}</span></p>
                        <p class="text-xs text-gray-400 mt-1">${esc(p.modalidade)} · ${esc(periodos || "sem horários")} · ponto ${fmtMin(Number(p.total_diario_horas) * 60)} · atividades ${fmtMin(minAtv)} · aprovado ${fmtMin(minApr)}</p>
                    </div>
                    ${qtdPend ? `<button type="button" data-aprovar-dia="${p.id}" data-qtd="${qtdPend}" class="text-xs px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Aprovar dia (${qtdPend})</button>`
                              : `<span class="px-2 py-0.5 text-xs rounded-full bg-emerald-900 text-emerald-300">Dia avaliado</span>`}
                </div>
                ${linhas || `<p class="text-xs text-gray-500 py-3 border-t border-gray-700">Sem atividades neste dia.</p>`}
            </article>`;
        }).join("");
    }

    async function avaliar(id, status, minutos = null, motivo = null) {
        const { error } = await sb.rpc("avaliar_atividade", {
            p_atividade_id: id, p_status: status, p_minutos_aprovados: minutos, p_motivo: motivo
        });
        if (error) { toast(msgErro(error), "erro"); return false; }
        return true;
    }

    $("g-buscar").addEventListener("click", carregarGestor);
    $("g-status").addEventListener("change", renderGestor);
    $("g-colab").addEventListener("change", carregarGestor);

    $("g-lista").addEventListener("click", async (e) => {
        const check = e.target.closest("[data-check]");
        const ajustar = e.target.closest("[data-ajustar]");
        const aprovarDia = e.target.closest("[data-aprovar-dia]");

        if (check) {
            // controlamos o estado do checkbox manualmente (ele só muda após a resposta do banco)
            e.preventDefault();
            const status = check.dataset.status;
            if (status === "Aprovado Integral") {
                const ok = await confirmarModal({ titulo: "Reabrir avaliação?", texto: "A atividade volta para Pendente e o colaborador poderá alterá-la novamente.", botao: "Reabrir" });
                if (!ok) return;
                if (await avaliar(check.dataset.check, "Pendente")) { toast("Avaliação reaberta.", "aviso"); await carregarGestor(); }
            } else {
                if (status !== "Pendente") {
                    const ok = await confirmarModal({ titulo: "Alterar avaliação?", texto: `Esta atividade está como “${status}”. Deseja aprová-la integralmente?`, botao: "Aprovar" });
                    if (!ok) return;
                }
                if (await avaliar(check.dataset.check, "Aprovado Integral")) { toast("Atividade aprovada."); await carregarGestor(); }
            }
            return;
        }

        if (aprovarDia) {
            const qtd = Number(aprovarDia.dataset.qtd || 0);
            const ok = await confirmarModal({
                titulo: "Aprovar o dia?",
                texto: `${qtd === 1 ? "A atividade pendente será aprovada" : `As ${qtd} atividades pendentes serão aprovadas`} integralmente.`,
                botao: "Aprovar dia"
            });
            if (!ok) return;
            const { data, error } = await sb.rpc("aprovar_dia", { p_ponto_id: aprovarDia.dataset.aprovarDia });
            if (error) return toast(msgErro(error), "erro");
            toast(`${data} atividade(s) aprovada(s).`);
            await carregarGestor();
            return;
        }

        if (ajustar) {
            avaliando = { id: ajustar.dataset.ajustar, realizado: Number(ajustar.dataset.realizado || 0) };
            $("av-descricao").textContent = ajustar.dataset.desc;
            $("av-realizado").textContent = `(realizado: ${fmtMin(avaliando.realizado)})`;
            $("av-decisao").value = "parcial";
            $("av-minutos").value = avaliando.realizado > 1 ? Math.floor(avaliando.realizado / 2) : "";
            $("av-motivo").value = "";
            $("av-erro").classList.add("hidden");
            atualizarDecisao();
            $("modal-avaliar").classList.remove("hidden");
            $("av-minutos").focus();
        }
    });

    function atualizarDecisao() {
        const rejeitar = $("av-decisao").value === "rejeitar";
        $("av-minutos-box").classList.toggle("hidden", rejeitar);
        $("av-motivo-label").textContent = rejeitar ? "Motivo da rejeição (obrigatório)" : "Observação (opcional)";
    }
    $("av-decisao").addEventListener("change", atualizarDecisao);

    function fecharAvaliar() {
        $("modal-avaliar").classList.add("hidden");
        avaliando = null;
    }
    $("av-cancelar").addEventListener("click", fecharAvaliar);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !$("modal-avaliar").classList.contains("hidden")) fecharAvaliar();
    });

    $("av-salvar").addEventListener("click", async () => {
        if (!avaliando) return;
        const rejeitar = $("av-decisao").value === "rejeitar";
        const motivo = $("av-motivo").value.trim();
        const erro = $("av-erro");
        const mostrar = (m) => { erro.textContent = m; erro.classList.remove("hidden"); };

        let status, minutos = null;
        if (rejeitar) {
            if (!motivo) return mostrar("Informe o motivo da rejeição.");
            status = "Glosado/Rejeitado";
        } else {
            minutos = parseInt($("av-minutos").value, 10);
            if (isNaN(minutos) || minutos <= 0) return mostrar("Informe o tempo aprovado, em minutos.");
            if (minutos >= avaliando.realizado) return mostrar(`Na aprovação parcial, o tempo deve ser menor que o realizado (${avaliando.realizado} min). Para aprovar tudo, use o check.`);
            status = "Aprovado Parcial";
        }

        $("av-salvar").disabled = true;
        const ok = await avaliar(avaliando.id, status, minutos, motivo || null);
        $("av-salvar").disabled = false;
        if (ok) {
            fecharAvaliar();
            toast(rejeitar ? "Atividade rejeitada." : "Aprovação parcial registrada.");
            await carregarGestor();
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
