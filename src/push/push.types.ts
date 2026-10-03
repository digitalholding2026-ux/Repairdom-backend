/* Push web VAPID (chantier #2B, complément du SSE pour app fermée).
 * Types partagés : abonnement navigateur + payload de notification. */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string | null;
  deviceLabel?: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: {
    url: string;
    type: string;
  };
}

export interface PushSendResult {
  sent: number;
  skipped: string | null;
  failed: number;
}
