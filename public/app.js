const SUPABASE_URL = "https://yoywnhuewdxkfuqwrbbt.supabase.co";
const SUPABASE_KEY = "sb_publishable_5LW2Y6nn91TMXBbK3CADMg_DvdsypxT"; // Cole a sua Publishable Key (sb_publishable_...)

let sb;

// Garante que o script só roda após o HTML carregar por completo
document.addEventListener("DOMContentLoaded", () => {
    
    // Inicializa Supabase
    if (window.supabase) {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
        console.error("SDK do Supabase não foi carregado.");
    }

    // Elementos DOM
    const authScreen = document.getElementById("auth-screen");
    const appScreen = document.getElementById("app-screen");

    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");

    const btnShowRegister = document.getElementById("btn-show-register");
    const btnShowLogin = document.getElementById("btn-show-login");
    const btnLogout = document.getElementById("btn-logout");
    const userDisplay = document.getElementById("user-display");

    // Alternar para tela de Cadastro ao clicar em "Cadastrar-se"
    if (btnShowRegister) {
        btnShowRegister.addEventListener("click", (e) => {
            e.preventDefault();
            console.log("Alternando para cadastro...");
            if (loginForm && registerForm) {
                loginForm.classList.add("hidden");
                registerForm.classList.remove("hidden");
            }
        });
    }

    // Alternar para tela de Login ao clicar em "Fazer Login"
    if (btnShowLogin) {
        btnShowLogin.addEventListener("click", (e) => {
            e.preventDefault();
            console.log("Alternando para login...");
            if (loginForm && registerForm) {
                registerForm.classList.add("hidden");
                loginForm.classList.remove("hidden");
            }
        });
    }

    // Ação de Login
    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const email = document.getElementById("login-email").value;
            const password = document.getElementById("login-password").value;

            if (!sb) return alert("Erro ao conectar ao banco de dados.");

            const { data, error } = await sb.auth.signInWithPassword({ email, password });

            if (error) {
                alert("Erro ao fazer login: " + error.message);
            } else {
                carregarApp(data.user);
            }
        });
    }

    // Ação de Cadastro
    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const nome = document.getElementById("reg-nome").value;
            const sexo = document.getElementById("reg-sexo").value;
            const email = document.getElementById("reg-email").value;
            const celular = document.getElementById("reg-celular").value;
            const password = document.getElementById("reg-password").value;
            const passwordConfirm = document.getElementById("reg-password-confirm").value;
            const passwordError = document.getElementById("reg-password-error");

            if (password !== passwordConfirm) {
                if (passwordError) passwordError.classList.remove("hidden");
                return;
            }
            if (passwordError) passwordError.classList.add("hidden");

            if (!sb) return alert("Erro ao conectar ao banco de dados.");

            // O perfil (role) é sempre definido como 'colaborador' no banco.
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        nome_completo: nome.trim(),
                        username: email.split('@')[0],
                        sexo: sexo,
                        celular: celular.trim()
                    }
                }
            });

            if (error) {
                alert("Erro ao cadastrar: " + error.message);
            } else {
                alert("Cadastro realizado com sucesso! Faça login para continuar.");
                registerForm.classList.add("hidden");
                loginForm.classList.remove("hidden");
            }
        });
    }

    // Logout
    if (btnLogout) {
        btnLogout.addEventListener("click", async () => {
            if (sb) await sb.auth.signOut();
            location.reload();
        });
    }

    // Carregar App pós Login
    async function carregarApp(user) {
        if (authScreen) authScreen.classList.add("hidden");
        if (appScreen) appScreen.classList.remove("hidden");
        if (userDisplay) userDisplay.textContent = user.email;

        const { data: perfil } = await sb.from("perfis").select("*").eq("id", user.id).single();

        if (perfil && (perfil.role === 'gestor' || perfil.role === 'admin')) {
            const tabAprovacao = document.getElementById("tab-aprovação");
            const roleBadge = document.getElementById("user-role-badge");
            if (tabAprovacao) tabAprovacao.classList.remove("hidden");
            if (roleBadge) roleBadge.textContent = perfil.role.toUpperCase();
        }
    }
});
