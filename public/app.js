const SUPABASE_URL = "https://yoywnhuewdxkfuqwrbbt.supabase.co";
const SUPABASE_KEY = "sb_publishable_5LW2Y6nn91TMXBbK3CADMg_DvdsypxT"; // Substitua pela sua anon key do Supabase

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Elementos DOM
const authScreen = document.getElementById("auth-screen");
const appScreen = document.getElementById("app-screen");

const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

const btnShowRegister = document.getElementById("btn-show-register");
const btnShowLogin = document.getElementById("btn-show-login");
const btnLogout = document.getElementById("btn-logout");
const userDisplay = document.getElementById("user-display");

// Alternar entre formulários
btnShowRegister.addEventListener("click", () => {
    loginForm.classList.add("hidden");
    registerForm.classList.remove("hidden");
});

btnShowLogin.addEventListener("click", () => {
    registerForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
});

// Ação de Login
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        alert("Erro ao fazer login: " + error.message);
    } else {
        carregarApp(data.user);
    }
});

// Ação de Registo/Cadastro
registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = document.getElementById("reg-nome").value;
    const email = document.getElementById("reg-email").value;
    const password = document.getElementById("reg-password").value;
    const role = document.getElementById("reg-role").value;

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                nome_completo: nome,
                username: email.split('@')[0],
                role: role
            }
        }
    });

    if (error) {
        alert("Erro ao registar utilizador: " + error.message);
    } else {
        alert("Registo efetuado com sucesso! Se a confirmação de e-mail estiver ativa no Supabase, verifique a sua caixa de entrada.");
        registerForm.classList.add("hidden");
        loginForm.classList.remove("hidden");
    }
});

// Logout
btnLogout.addEventListener("click", async () => {
    await supabase.auth.signOut();
    location.reload();
});

// Carregar Aplicação pós Autenticação
async function carregarApp(user) {
    authScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    userDisplay.textContent = user.email;

    const { data: perfil } = await supabase.from("perfis").select("*").eq("id", user.id).single();

    if (perfil && (perfil.role === 'gestor' || perfil.role === 'admin')) {
        document.getElementById("tab-aprovação").classList.remove("hidden");
        document.getElementById("user-role-badge").textContent = perfil.role.toUpperCase();
    }
}
