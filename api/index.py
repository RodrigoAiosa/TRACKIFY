import os
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
from supabase import create_client, Client

app = FastAPI(title="Trackify API", version="1.0.0")

# Habilitar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

def get_supabase() -> Client:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=500, detail="Variáveis do Supabase não configuradas.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)

# Modelos Pydantic
class PontoSchema(BaseModel):
    usuario_id: str
    data: str
    modalidade: str
    entrada_1: Optional[str] = None
    saida_1: Optional[str] = None
    entrada_2: Optional[str] = None
    saida_2: Optional[str] = None
    entrada_3: Optional[str] = None
    saida_3: Optional[str] = None
    total_diario_horas: Optional[float] = 0.0

class AtividadeSchema(BaseModel):
    ponto_id: Optional[str] = None
    usuario_id: str
    gestor_id: Optional[str] = None
    data: str
    projeto_id: Optional[int] = None
    tipo_atividade_id: Optional[int] = None
    descricao_atividade: str
    prioridade_dia: Optional[int] = 1
    duracao_prevista_minutos: Optional[int] = 0
    duracao_realizada_minutos: Optional[int] = 0
    intercorrencias: Optional[str] = None

class AprovacaoSchema(BaseModel):
    atividade_id: str
    duracao_autorizada_minutos: int
    duracao_aprovada_minutos: int
    status_aprovacao: str
    motivo_nao_aprovação: Optional[str] = None
    travar_registro: Optional[bool] = False

@app.get("/api/health")
def health_check():
    return {"status": "ok", "app": "Trackify API", "version": "1.0.0"}

@app.post("/api/ponto")
def salvar_ponto(ponto: PontoSchema):
    supabase = get_supabase()
    res = supabase.table("apontamentos_ponto").upsert(ponto.dict(), on_conflict="usuario_id,data").execute()
    return {"data": res.data}

@app.get("/api/ponto/{usuario_id}/{data}")
def buscar_ponto(usuario_id: str, data: str):
    supabase = get_supabase()
    res = supabase.table("apontamentos_ponto").select("*").eq("usuario_id", usuario_id).eq("data", data).execute()
    return {"data": res.data}

@app.post("/api/atividades")
def criar_atividade(atividade: AtividadeSchema):
    supabase = get_supabase()
    res = supabase.table("apontamentos_atividades").insert(atividade.dict()).execute()
    return {"data": res.data}

@app.get("/api/atividades/{usuario_id}/{data}")
def listar_atividades_dia(usuario_id: str, data: str):
    supabase = get_supabase()
    res = supabase.table("apontamentos_atividades").select("*, projetos(nome_projeto), tipos_atividade(nome)").eq("usuario_id", usuario_id).eq("data", data).execute()
    return {"data": res.data}

@app.put("/api/gestor/aprovar")
def aprovar_atividade(dados: AprovacaoSchema):
    supabase = get_supabase()
    payload = {
        "duracao_autorizada_minutos": dados.duracao_autorizada_minutos,
        "duracao_aprovada_minutos": dados.duracao_aprovada_minutos,
        "status_aprovacao": dados.status_aprovacao,
        "motivo_nao_aprovação": dados.motivo_nao_aprovação,
        "registro_travado": dados.travar_registro
    }
    res = supabase.table("apontamentos_atividades").update(payload).eq("id", dados.atividade_id).execute()
    return {"data": res.data}
