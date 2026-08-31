-- RepairDom — Migration : Messagerie (conversations, présence, négociation de prix)
-- À exécuter dans l'éditeur SQL de Supabase (SQL editor).

-- 1) Présence en ligne / hors ligne
--    `last_seen` est mis à jour par le client (heartbeat ~15s). Un utilisateur est
--    considéré "en ligne" si last_seen remonte à moins de ~40s.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_seen timestamptz;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS last_seen timestamptz;

-- 2) Marqueurs de lecture des messages (indicateur non lu)
--    read_by_client   : vrai si le message a été lu par le client
--    read_by_technician: vrai si le message a été lu par le technicien
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_by_client boolean DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_by_technician boolean DEFAULT false;

-- 3) Table des propositions de prix (négociation avec validation)
--    Un prix proposé par le client OU le technicien n'est appliqué à la mission
--    (colonne price) ET au reçu que lorsqu'il est accepté par l'autre partie.
CREATE TABLE IF NOT EXISTS price_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  proposer_role text NOT NULL CHECK (proposer_role IN ('client', 'technician')),
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'declined', 'replaced')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_price_proposals_mission
  ON price_proposals (mission_id, created_at);
