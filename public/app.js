// Configuração do Supabase (Substitua pelas suas chaves ou injete dinamicamente)
const SUPABASE_URL = "https://yoywnhuewdxkfuqwrbbt.supabase.co";
const SUPABASE_KEY = "SUA_SUPABASE_ANON_KEY"; 

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Elementos DOM
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginForm = document.getElementById("login-form");
const btnLogout = document.getElementById("btn-logout");
const userDisplay = document.getElementById("user-display");

// Evento de Login
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        alert("Erro ao fazer login: " + error.message);
    } else {
        carregarApp(data.user);
    }
});

// Evento de Logout
btnLogout.addEventListener("click", async () => {
    await supabase.auth.signOut();
    location.reload();
});

// Carregar Aplicação pós Auth
async function carregarApp(user) {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    userDisplay.textContent = user.email;

    // Buscar perfil do usuário
    const { data: perfil } = await supabase.from("perfis").select("*").eq("id", user.id).single();

    if (perfil && (perfil.role === 'gestor' || perfil.role === 'admin')) {
        document.getElementById("tab-aprovação").classList.remove("hidden");
        document.getElementById("user-role-badge").textContent = perfil.role.toUpperCase();
    }
}
