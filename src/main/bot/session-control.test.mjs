import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionControl} from './session-control.mjs';

function fixture() {
  let time = 0, running = false, online = false;
  const changes = [];
  const controls = createSessionControl({now: () => time, leaseMs: 60000, active: () => running,
    connected: () => online, changed: (...args) => changes.push(args)});
  return {controls, changes, advance(ms) {time += ms;}, running(value) {running = value;}, online(value) {online = value;}};
}

test('reading never acquires; the first writer owns only its conversation', () => {
  const {controls} = fixture(); assert.equal(controls.get('a'), null);
  const owner = controls.requireWriter('a', 'pc');
  assert.equal(controls.get('a').ownerId, 'pc'); assert.equal(controls.get('b'), null);
  assert.equal(controls.acquire('a', 'phone').ok, false);
  assert.throws(() => controls.requireWriter('a', 'phone'), /会话已被/);
  assert.equal(controls.requireWriter('a', 'pc', owner.epoch).epoch, owner.epoch);
});

test('explicit takeover immediately fences every previous writer request; stale releases cannot unlock the new owner', () => {
  const {controls} = fixture(), original = controls.acquire('a', 'pc').control;
  const next = controls.acquire('a', 'phone', true).control;
  assert.equal(controls.acquire('a', 'phone', true).control.epoch, next.epoch, '重复抢占回执不使自己的在途提交失效');
  assert.notEqual(next.epoch, original.epoch);
  assert.throws(() => controls.requireWriter('a', 'pc', original.epoch), /会话已被/);
  assert.equal(controls.release('a', 'pc', original.epoch), false);
  const returned = controls.acquire('a', 'pc', true).control;
  assert.throws(() => controls.requireWriter('a', 'pc', original.epoch), /会话已被/);
  assert.equal(controls.requireWriter('a', 'pc', returned.epoch).epoch, returned.epoch);
});

test('an idle disconnected lease expires, while a live editor or active task retains ownership', () => {
  const f = fixture(); f.controls.acquire('a', 'pc'); f.online(true); f.advance(61000); f.controls.sweep();
  assert.equal(f.controls.get('a').ownerId, 'pc');
  f.online(false); f.running(true); f.advance(61000); f.controls.sweep(); assert.equal(f.controls.get('a').ownerId, 'pc');
  f.running(false); f.advance(61000); f.controls.sweep(); assert.equal(f.controls.get('a'), null);
  assert.equal(f.controls.acquire('a', 'phone').ok, true);
});

test('leaving releases idle ownership immediately and releases active ownership after its task ends', () => {
  const f = fixture(), first = f.controls.acquire('a', 'pc').control;
  assert.equal(f.controls.release('a', 'pc', first.epoch), true);
  assert.throws(() => f.controls.requireWriter('a', 'pc', first.epoch), /占用已释放/);
  const next = f.controls.acquire('a', 'pc').control; f.running(true); f.online(true);
  assert.equal(f.controls.release('a', 'pc', next.epoch), false);
  f.running(false); f.controls.sweep(); assert.equal(f.controls.get('a'), null);
});
