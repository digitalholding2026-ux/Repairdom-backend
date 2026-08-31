-- RepairDom — Migration : Négociation mutualisée
-- À exécuter dans l'éditeur SQL de Supabase.

-- 1) Colonne negotiation_status sur missions
--    Valeurs : pending | client_proposed | tech_proposed | accepted | rejected
ALTER TABLE missions ADD COLUMN IF NOT EXISTS negotiation_status text DEFAULT 'pending'
  CHECK (negotiation_status IN ('pending', 'client_proposed', 'tech_proposed', 'accepted', 'rejected'));

-- 2) Colonne system_price : prix calculé par le système (catalogue + frais)
ALTER TABLE missions ADD COLUMN IF NOT EXISTS system_price numeric;

-- 3) Colonne travel_fee : frais de déplacement estimés
ALTER TABLE missions ADD COLUMN IF NOT EXISTS travel_fee numeric DEFAULT 2000;
