-- ======================================================================
-- ADENDO DE AUTENTICAÇÃO (camada de aplicação — não altera o núcleo)
-- Em produção, isto é substituído por Supabase Auth (users.id = auth.users.id),
-- conforme já definido no Blueprint §21. Este sandbox não tem acesso à internet
-- para o serviço Supabase, então uso autenticação local equivalente para testar
-- o fluxo ponta a ponta. Nenhuma tabela do núcleo é alterada estruturalmente
-- em seu comportamento — só adiciono a coluna de credencial em `users`.
-- ======================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Usuário de teste (mesmo profissional já usado nos 10 casos de teste)
UPDATE users SET password_hash = '$2a$10$PLACEHOLDER'
WHERE email = 'getulio@getuliocoelho.com.br';
