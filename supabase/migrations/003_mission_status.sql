-- RepairDom — Migration : Statut de mission, annulation et reprogrammation
-- À exécuter dans l'éditeur SQL de Supabase.

-- 1) Colonne technician_status : avancement du déplacement du technicien.
--    pending      : en attente de prise en charge
--    on_the_way   : en route vers le domicile du client
--    in_progress  : intervention en cours sur l'appareil
--    completed    : mission terminée
--    cancelled    : mission annulée
ALTER TABLE missions ADD COLUMN IF NOT EXISTS technician_status text DEFAULT 'pending'
  CHECK (technician_status IN ('pending', 'on_the_way', 'in_progress', 'completed', 'cancelled'));

-- 2) Colonne cancellation_reason : motif de l'annulation (nullable).
ALTER TABLE missions ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- 3) Colonne reschedule_date : nouvelle date de rendez-vous (nullable).
ALTER TABLE missions ADD COLUMN IF NOT EXISTS reschedule_date timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) Politiques RLS sur missions
--
--    Le produit repose sur une authentification JWT CUSTOM gérée côté serveur
--    (backend/Server), qui accède à la base via la clé service_role (contourne
--    RLS). RLS ne s'applique donc PAS aux requêtes du backend.
--
--    Si (à l'avenir) on bascule les clients/techniciens vers Supabase Auth,
--    il suffit d'ajouter les colonnes user_id sur clients et technicians puis
--    d'exécuter les blocs ci-dessous pour restreindre l'accès direct :
--      * un client / un technicien ne lit qu'UNIQUEMENT ses missions ;
--      * il n'écrit UNIQUEMENT que sur ses propres missions.
--
--    Ces blocs utiliseront la liaison habituelle :
--        missions.client_id      -> clients.user_id    = auth.uid()
--        missions.technician_id  -> technicians.user_id = auth.uid()
--    (les deux sont protégés par un garde 'IF NOT EXISTS' sur la colonne
--     user_id, donc la migration ne casse pas si on ne l'a pas encore).
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Active RLS sur missions uniquement si la colonne de liaison existe.
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'clients'
      AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'technicians'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE missions ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Suppression préalable (idempotence) si les politiques existaient déjà.
DROP POLICY IF EXISTS missions_client_select ON missions;
DROP POLICY IF EXISTS missions_client_update ON missions;
DROP POLICY IF EXISTS missions_technician_select ON missions;
DROP POLICY IF EXISTS missions_technician_update ON missions;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'clients'
      AND column_name = 'user_id'
  ) THEN
    -- Lecture : le client connecté ne voit que ses propres missions.
    EXECUTE format('
      CREATE POLICY missions_client_select ON missions
        FOR SELECT
        USING (EXISTS (
          SELECT 1 FROM clients
          WHERE clients.id = missions.client_id
            AND clients.user_id = auth.uid()
        ));
    ');
    -- Écriture (statut / annulation / reprogrammation) : uniquement ses missions.
    EXECUTE format('
      CREATE POLICY missions_client_update ON missions
        FOR UPDATE
        USING (EXISTS (
          SELECT 1 FROM clients
          WHERE clients.id = missions.client_id
            AND clients.user_id = auth.uid()
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM clients
          WHERE clients.id = missions.client_id
            AND clients.user_id = auth.uid()
        ));
    ');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'technicians'
      AND column_name = 'user_id'
  ) THEN
    -- Lecture : le technicien connecté ne voit que ses missions.
    EXECUTE format('
      CREATE POLICY missions_technician_select ON missions
        FOR SELECT
        USING (EXISTS (
          SELECT 1 FROM technicians
          WHERE technicians.id = missions.technician_id
            AND technicians.user_id = auth.uid()
        ));
    ');
    -- Écriture : uniquement ses missions.
    EXECUTE format('
      CREATE POLICY missions_technician_update ON missions
        FOR UPDATE
        USING (EXISTS (
          SELECT 1 FROM technicians
          WHERE technicians.id = missions.technician_id
            AND technicians.user_id = auth.uid()
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM technicians
          WHERE technicians.id = missions.technician_id
            AND technicians.user_id = auth.uid()
        ));
    ');
  END IF;
END $$;
