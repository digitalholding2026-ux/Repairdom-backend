import { describe, expect, it, vi } from 'vitest';
import { SasPayWebhookController } from './saspay-webhook.controller.js';

/* Sprint SASPAY-03 — le contrôleur exige les octets exacts (req.rawBody) :
 * sans raw body → 401 (jamais de re-sérialisation) ; le JSON n'est parsé
 * qu'après vérification de la signature. */

function controller() {
  const webhooks = {
    verifySignature: vi.fn(),
    handleEvent: vi.fn(async () => ({ handled: true, event: 'transaction.success', credited: true })),
  };
  return { controller: new SasPayWebhookController(webhooks as never), webhooks };
}

describe('webhook controller : raw body exact exigé', () => {
  it('sans rawBody → 401, service jamais appelé', async () => {
    const { controller: c, webhooks } = controller();
    await expect(
      c.handle({} as never, 'sig', '123', 'transaction.success'),
    ).rejects.toMatchObject({ status: 401 });
    expect(webhooks.verifySignature).not.toHaveBeenCalled();
    expect(webhooks.handleEvent).not.toHaveBeenCalled();
  });

  it('rawBody présent → vérifié à l\'octet près puis parsé (enveloppe event/data)', async () => {
    const { controller: c, webhooks } = controller();
    const raw = Buffer.from('{"event":"transaction.success","data":{"id":"sp-1"}}');
    const result = await c.handle({ rawBody: raw } as never, 'sig', '123', 'transaction.success');
    expect(webhooks.verifySignature).toHaveBeenCalledTimes(1);
    // Les octets exacts sont transmis (même référence Buffer), pas un JSON reconstruit.
    expect(webhooks.verifySignature).toHaveBeenCalledWith(raw, '123', 'sig');
    expect(webhooks.handleEvent).toHaveBeenCalledWith('transaction.success', { id: 'sp-1' });
    expect(result).toMatchObject({ received: true, handled: true });
  });

  it('signature refusée → l\'erreur se propage, rien n\'est traité', async () => {
    const { controller: c, webhooks } = controller();
    webhooks.verifySignature.mockImplementationOnce(() => {
      throw Object.assign(new Error('Signature webhook invalide.'), { status: 401 });
    });
    const raw = Buffer.from('{"event":"transaction.success","data":{}}');
    await expect(c.handle({ rawBody: raw } as never, 'bad', '123', 'x')).rejects.toMatchObject({
      status: 401,
    });
    expect(webhooks.handleEvent).not.toHaveBeenCalled();
  });

  it('rawBody non-JSON mais signé → 401 (parse après vérification uniquement)', async () => {
    const { controller: c, webhooks } = controller();
    const raw = Buffer.from('not-json{{{');
    await expect(c.handle({ rawBody: raw } as never, 'sig', '123', 'x')).rejects.toMatchObject({
      status: 401,
    });
    expect(webhooks.verifySignature).toHaveBeenCalledTimes(1);
    expect(webhooks.handleEvent).not.toHaveBeenCalled();
  });
});
