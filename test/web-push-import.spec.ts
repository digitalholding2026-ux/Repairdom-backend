import { describe, expect, it } from 'vitest';
import webPush from 'web-push';

/* Garde-fou interop ESM/CommonJS (crash Railway P0) : `web-push` est un
 * package CommonJS. Avec `import * as webPush`, `setVapidDetails` se
 * retrouvait sous `webPush.default` et le boot crashait
 * (`setVapidDetails is not a function`). Ce test importe le module RÉEL
 * (SANS mock, contrairement à push.spec.ts) et échoue si l'import ne
 * produit pas un objet exploitable au runtime. */

describe('web-push — import réel exploitable', () => {
  it('setVapidDetails est une fonction', () => {
    expect(typeof webPush.setVapidDetails).toBe('function');
  });

  it('sendNotification est une fonction', () => {
    expect(typeof webPush.sendNotification).toBe('function');
  });

  it('generateVAPIDKeys est une fonction', () => {
    expect(typeof webPush.generateVAPIDKeys).toBe('function');
  });
});
