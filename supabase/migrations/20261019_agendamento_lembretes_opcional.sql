-- Trackify: agendamento diário dos lembretes (OPCIONAL)
-- Sem este script os lembretes continuam funcionando, mas só são gerados quando a pessoa abre o sistema.
-- Com ele, o Supabase gera os lembretes todo dia útil de manhã, mesmo para quem não entrou.
-- Aplicar no SQL Editor depois de 20261019_calendario_banco_horas_avisos_auditoria.sql.

create extension if not exists pg_cron;

-- 11:00 UTC = 08:00 em Brasília, de segunda a sexta
select cron.unschedule('trackify-lembretes') where exists (select 1 from cron.job where jobname = 'trackify-lembretes');
select cron.schedule('trackify-lembretes', '0 11 * * 1-5', $$select private.gerar_lembretes()$$);

-- Para conferir:  select jobname, schedule, active from cron.job;
-- Para desligar:  select cron.unschedule('trackify-lembretes');

-- ---------------------------------------------------------------------------------
-- E-mail dos avisos (depende da função "enviar-notificacoes", ver supabase/functions)
-- Depois de publicar a função e definir os segredos, descomente, troque os dois
-- valores entre <> e rode. O texto do segredo é o mesmo que você definiu em CRON_SECRET.
-- ---------------------------------------------------------------------------------
-- create extension if not exists pg_net;
-- select cron.unschedule('trackify-email') where exists (select 1 from cron.job where jobname = 'trackify-email');
-- select cron.schedule('trackify-email', '15 11 * * 1-5', $$
--   select net.http_post(
--     url := 'https://yoywnhuewdxkfuqwrbbt.supabase.co/functions/v1/enviar-notificacoes',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<SEGREDO>'),
--     body := '{}'::jsonb)
-- $$);
