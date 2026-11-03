// Verification only: inspect the effective saved-group state in a NEW, isolated
// Chrome profile after Chrome exits. Raw byte searches include deleted history.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

function varint(buffer, cursor) {
  let value = 0;
  let factor = 1;
  for (let i = 0; i < 10; i++) {
    assert.ok(cursor.offset < buffer.length, 'Truncated varint');
    const byte = buffer[cursor.offset++];
    value += (byte & 127) * factor;
    if (!(byte & 128)) return value;
    factor *= 128;
  }
  throw new Error('Invalid varint');
}

function lengthDelimited(buffer, cursor) {
  const length = varint(buffer, cursor);
  assert.ok(length <= buffer.length - cursor.offset, 'Truncated length-delimited value');
  const value = buffer.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function protoFields(buffer) {
  const cursor = { offset: 0 };
  const fields = new Map();
  while (cursor.offset < buffer.length) {
    const tag = varint(buffer, cursor);
    const number = Math.floor(tag / 8);
    let value;
    switch (tag % 8) {
      case 0: value = varint(buffer, cursor); break;
      case 1: value = buffer.subarray(cursor.offset, cursor.offset + 8); cursor.offset += 8; break;
      case 2: value = lengthDelimited(buffer, cursor); break;
      case 5: value = buffer.subarray(cursor.offset, cursor.offset + 4); cursor.offset += 4; break;
      default: throw new Error(`Unsupported protobuf wire type ${tag % 8}`);
    }
    assert.ok(cursor.offset <= buffer.length && number > 0, 'Invalid protobuf field');
    fields.set(number, value);
  }
  return fields;
}

function* logRecords(buffer) {
  let offset = 0;
  let fragments = [];
  while (offset < buffer.length) {
    const remainingBlock = 32768 - offset % 32768;
    if (remainingBlock < 7) { offset += remainingBlock; continue; }
    assert.ok(offset + 7 <= buffer.length, 'Truncated LevelDB log header');
    const length = buffer.readUInt16LE(offset + 4);
    const type = buffer[offset + 6];
    offset += 7;
    if (type === 0 && length === 0) { offset += remainingBlock - 7; continue; }
    assert.ok(length <= remainingBlock - 7 && offset + length <= buffer.length, 'Truncated LevelDB record');
    const fragment = buffer.subarray(offset, offset + length);
    offset += length;
    switch (type) {
      case 1: assert.equal(fragments.length, 0); yield fragment; break;
      case 2: assert.equal(fragments.length, 0); fragments = [fragment]; break;
      case 3: assert.ok(fragments.length); fragments.push(fragment); break;
      case 4: assert.ok(fragments.length); yield Buffer.concat([...fragments, fragment]); fragments = []; break;
      default: throw new Error(`Invalid LevelDB log record type ${type}`);
    }
  }
  assert.equal(fragments.length, 0, 'Incomplete LevelDB logical record');
}

export async function readSavedGroupsFromFreshProfile(profile) {
  const root = path.join(profile, 'Default', 'Sync Data', 'LevelDB');
  const files = await fs.readdir(root);
  // This helper deliberately refuses a compacted/personal database. The bounded
  // fixture produces only WALs; silently omitting SSTables would prove nothing.
  assert.equal(files.some(file => /\.(ldb|sst)$/.test(file)), false, 'Fixture exceeded WAL-only profile scope');
  const logs = files.filter(file => /^\d+\.log$/.test(file)).sort();
  assert.ok(logs.length, 'Chrome did not create the saved-group fixture database');
  const state = new Map();
  let groupEntityWrites = 0;
  let tombstones = 0;
  for (const file of logs) {
    for (const batch of logRecords(await fs.readFile(path.join(root, file)))) {
      assert.ok(batch.length >= 12, 'Truncated LevelDB WriteBatch');
      const sequence = batch.readBigUInt64LE(0);
      const count = batch.readUInt32LE(8);
      const cursor = { offset: 12 };
      for (let index = 0; index < count; index++) {
        const kind = batch[cursor.offset++];
        assert.ok(kind === 0 || kind === 1, 'Unknown LevelDB WriteBatch operation');
        const key = lengthDelimited(batch, cursor).toString('utf8');
        const value = kind === 1 ? lengthDelimited(batch, cursor) : null;
        if (!key.startsWith('saved_tab_group-dt-')) continue;
        const seq = sequence + BigInt(index);
        if (kind === 0) tombstones++;
        else groupEntityWrites++;
        if (!state.has(key) || state.get(key).sequence < seq) state.set(key, { sequence: seq, value });
      }
      assert.equal(cursor.offset, batch.length, 'LevelDB WriteBatch length mismatch');
    }
  }
  const groups = [];
  for (const { value } of state.values()) {
    if (!value) continue;
    // DataTypeStore wrapper field 2 -> SavedTabGroupSpecifics. Group specifics
    // uses field 4; field 5 is a tab entity, which must not count as a group.
    const specificsBuffer = protoFields(value).get(2);
    assert.ok(Buffer.isBuffer(specificsBuffer), 'Missing SavedTabGroupSpecifics');
    const specifics = protoFields(specificsBuffer);
    const groupBuffer = specifics.get(4);
    if (!groupBuffer) continue;
    const group = protoFields(groupBuffer);
    groups.push({ guid: specifics.get(1).toString('utf8'), title: group.get(2)?.toString('utf8') ?? '' });
  }
  return { groups, groupEntityWrites, tombstones, logs };
}
