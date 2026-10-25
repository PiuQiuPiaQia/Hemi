import {randomUUID} from 'node:crypto';
import {fail} from './storage.mjs';

/** One active writer per conversation. Read-only viewers never acquire a lease. */
export function createSessionControl({now = Date.now, leaseMs = 60000, active, connected, changed}) {
  const owners = new Map();
  function get(id) {
    const owner = owners.get(id);
    if (owner && owner.expiresAt <= now() && !active(id) && !connected(owner.ownerId, id)) {
      owners.delete(id); changed(id); return null;
    }
    return owner ? {...owner} : null;
  }
  function acquire(id, ownerId, takeover = false) {
    const previous = get(id);
    if (previous && previous.ownerId !== ownerId && !takeover)
      return {ok: false, code: 'conflict', message: '会话已被另一台设备占用，请先抢占会话。', control: previous};
    if (previous?.ownerId === ownerId) {owners.get(id).leaving = false; return {ok: true, control: previous};}
    const control = {ownerId, epoch: randomUUID(), expiresAt: now() + leaseMs};
    owners.set(id, control); changed(id, previous, control);
    return {ok: true, control: {...control}};
  }
  function requireWriter(id, ownerId, epoch) {
    const owner = get(id);
    if (owner && (owner.ownerId !== ownerId || (epoch !== undefined && epoch !== owner.epoch)))
      fail('会话已被另一台设备占用，请先抢占会话。', 'conflict');
    if (!owner && epoch !== undefined) fail('会话占用已释放，请重新进入会话后再操作。', 'conflict');
    const result = owner ? {control: owner} : acquire(id, ownerId);
    owners.get(id).expiresAt = now() + leaseMs;
    owners.get(id).leaving = false;
    return result.control;
  }
  function release(id, ownerId, epoch, leaving = true) {
    const owner = get(id);
    if (!owner || owner.ownerId !== ownerId || (epoch !== undefined && owner.epoch !== epoch)) return false;
    if (leaving && active(id)) {owners.get(id).leaving = true; return false;}
    owners.delete(id); changed(id, owner, null); return true;
  }
  function sweep() {
    for (const [id, owner] of owners) {
      if (owner.leaving && !active(id)) {release(id, owner.ownerId, owner.epoch); continue;}
      if (active(id) || connected(owner.ownerId, id)) owner.expiresAt = now() + leaseMs;
      else get(id);
    }
  }
  return {get, acquire, requireWriter, release, sweep};
}
