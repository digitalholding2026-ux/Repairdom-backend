-- M2 — paramètres globaux de la plateforme (Settings).
--
-- Contexte : le numéro WhatsApp, le nom et l'avatar de l'admin étaient
-- codés en dur dans le frontend. Cette table permet de les configurer
-- depuis le back-office et de les exposer publiquement au frontend client
-- pour générer les liens WhatsApp propres.
--
-- Une seule ligne est attendue (id = "default"), upsertée par le seed.

CREATE TABLE IF NOT EXISTS "PlatformSetting" (
    "id"            TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
    "adminName"     TEXT NOT NULL DEFAULT 'Technicien Relio',
    "adminWhatsApp" TEXT NOT NULL DEFAULT '237600000000',
    "adminAvatarUrl" TEXT NULL,
    "supportEmail"   TEXT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL
);

INSERT INTO "PlatformSetting" ("id", "adminName", "adminWhatsApp", "adminAvatarUrl", "supportEmail", "createdAt", "updatedAt")
VALUES ('default', 'Technicien Relio', '237600000000', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
