import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  REALTIME_MAX_CONNECTIONS_PER_USER,
  REALTIME_PING_INTERVAL_MS,
  RealtimeService,
} from './realtime.service.js';
import { RealtimeController } from './realtime.controller.js';
import { missionChannel, userChannel } from './realtime.types.js';

/* Socle temps réel (SSE) : hub, ping, cleanup, quota, contrôle d'accès
 * mission. `Response`/`Request` simulés (EventEmitter pour `close`). */

function fakeRes() {
  return {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  };
}

function fakeReq() {
  return new EventEmitter() as never;
}

describe('RealtimeService — souscription et diffusion', () => {
  let service: RealtimeService;
  beforeEach(() => {
    service = new RealtimeService();
    service.onModuleInit();
  });
  afterEach(() => {
    vi.useRealTimers();
    service.onModuleDestroy();
  });

  it('subscribe → publish → événement reçu au format SSE', () => {
    const res = fakeRes();
    service.subscribe('u-1', 'CLIENT', [missionChannel('d-1')], res as never, fakeReq());
    service.publish(missionChannel('d-1'), 'mission.message_created', { messageId: 'm-1' });
    const chunks = (res.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    const data = chunks.find((c) => c.startsWith('event: mission.message_created'));
    expect(data).toBeDefined();
    const parsed = JSON.parse(data!.split('\n')[1].slice('data: '.length));
    expect(parsed).toMatchObject({
      type: 'mission.message_created',
      channel: 'mission:d-1',
      payload: { messageId: 'm-1' },
    });
    expect(typeof parsed.emittedAt).toBe('string');
  });

  it('un abonné à un autre channel ne reçoit rien', () => {
    const res = fakeRes();
    service.subscribe('u-1', 'CLIENT', [missionChannel('d-2')], res as never, fakeReq());
    service.publish(missionChannel('d-1'), 'mission.message_created', {});
    expect(res.write).toHaveBeenCalledTimes(1); // le `: connected` initial seul
  });

  it('publish ne lève jamais (payload circulaire, subscriber cassé)', () => {
    const res = fakeRes();
    (res.write as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('socket morte');
    });
    service.subscribe('u-1', 'CLIENT', [missionChannel('d-1')], res as never, fakeReq());
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      service.publish(missionChannel('d-1'), 'mission.status_changed', circular),
    ).not.toThrow();
  });

  it('ping émis toutes les 25 s (fake timers)', () => {
    const service = new RealtimeService();
    vi.useFakeTimers();
    service.onModuleInit();
    try {
      const res = fakeRes();
      service.subscribe('u-1', 'CLIENT', [userChannel('u-1')], res as never, fakeReq());
      (res.write as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
    } finally {
      service.onModuleDestroy();
    }
  });

  it("cleanup sur req.on('close')", () => {
    const res = fakeRes();
    const req = fakeReq() as unknown as EventEmitter;
    service.subscribe('u-1', 'CLIENT', [userChannel('u-1')], res as never, req as never);
    expect(service.subscriptionCount('u-1')).toBe(1);
    req.emit('close');
    expect(service.subscriptionCount('u-1')).toBe(0);
    expect(service.subscriptionCount()).toBe(0);
  });

  it('limite de 3 connexions par user (la plus ancienne fermée)', () => {
    const ends: unknown[] = [];
    for (let i = 0; i < REALTIME_MAX_CONNECTIONS_PER_USER + 1; i += 1) {
      const res = fakeRes();
      (res.end as ReturnType<typeof vi.fn>).mockImplementation(() => {
        ends.push(i);
        return true;
      });
      service.subscribe('u-1', 'CLIENT', [userChannel('u-1')], res as never, fakeReq());
    }
    expect(service.subscriptionCount('u-1')).toBe(REALTIME_MAX_CONNECTIONS_PER_USER);
    expect(ends).toHaveLength(1);
  });

  it('backpressure : write refusé → drop compté, pas d’empilement', () => {
    const res = fakeRes();
    (res.write as ReturnType<typeof vi.fn>).mockReturnValue(false);
    service.subscribe('u-1', 'CLIENT', [missionChannel('d-1')], res as never, fakeReq());
    expect(() =>
      service.publish(missionChannel('d-1'), 'mission.status_changed', { a: 1 }),
    ).not.toThrow();
    expect(service.subscriptionCount('u-1')).toBe(1);
  });
});

describe('RealtimeController — contrôle d’accès mission', () => {
  function controller(demande: { id: string; clientId: string; technicianId: string | null } | null) {
    const prisma = {
      demande: { findUnique: vi.fn(async () => demande) },
    };
    const service = new RealtimeService();
    const ctl = new RealtimeController(service, prisma as never);
    return { ctl, service, prisma };
  }

  function streamArgs(userId: string, role: 'CLIENT' | 'TECHNICIAN' = 'CLIENT') {
    const res = fakeRes();
    return {
      user: { id: userId, email: 'x@y.z', role },
      res,
      req: fakeReq(),
    };
  }

  it('client propriétaire → 200 + headers SSE + souscription mission', async () => {
    const { ctl, service } = controller({ id: 'd-1', clientId: 'c-1', technicianId: null });
    const { user, res, req } = streamArgs('c-1');
    await ctl.streamMission(user as never, 'd-1', req as never, res as never);
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      }),
    );
    expect(service.subscriptionCount('c-1')).toBe(1);
    service.onModuleDestroy();
  });

  it('tiers → 403 (jamais de souscription)', async () => {
    const { ctl, service } = controller({ id: 'd-1', clientId: 'c-1', technicianId: 't-1' });
    const { user, res, req } = streamArgs('intrus');
    await expect(ctl.streamMission(user as never, 'd-1', req as never, res as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.subscriptionCount()).toBe(0);
    service.onModuleDestroy();
  });

  it('mission inconnue → 404', async () => {
    const { ctl, service } = controller(null);
    const { user, res, req } = streamArgs('c-1');
    await expect(ctl.streamMission(user as never, 'd-9', req as never, res as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    service.onModuleDestroy();
  });
});
