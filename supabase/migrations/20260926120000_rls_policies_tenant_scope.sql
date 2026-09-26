-- Alinha as policies de manager e viewer com a regra de RBAC do middleware
-- (decisão 7 em docs/DECISOES_DE_PROJETO.md): TODA policy de SELECT passa a
-- exigir também `tenant_id` = tenant do usuário.
--
--   admin   -> tenant                          (já era assim)
--   manager -> tenant + departamento           (antes: só departamento)
--   viewer  -> tenant + owner                  (antes: só owner)
--
-- Por que: (1) a regra comparada nos dois cenários precisa ser idêntica, senão
-- a diferença de latência mistura "RLS vs middleware" com "regra simples vs
-- regra completa"; (2) sem o tenant, um manager enxergaria registros de outro
-- tenant que reaproveite o mesmo department_id.
--
-- Migration nova (não edita a anterior) porque 20260920120200 já foi aplicada.

drop policy if exists records_select_manager on records;
create policy records_select_manager on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and department_id = (select department_id from app_users where id = app_current_user_id())
    and (select role from app_users where id = app_current_user_id()) = 'manager'
  );

drop policy if exists records_select_viewer on records;
create policy records_select_viewer on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and owner_id = app_current_user_id()
    and (select role from app_users where id = app_current_user_id()) = 'viewer'
  );
