import test from 'node:test';
import assert from 'node:assert/strict';
import {SKINS,SKIN_IDS,getSkin} from './skins.mjs';
import {DEFAULT_APPEARANCE,validPreference,validSnapshot,newerSnapshot} from './schema.mjs';
const snapshot=(sessionId,revision)=>({sessionId,revision,preference:DEFAULT_APPEARANCE,resolvedMode:'light'});
test('six stable IDs share a complete token contract and unknown IDs fall back to classic',()=>{assert.deepEqual(SKIN_IDS,['classic','cafe-blue','cafe-purple','cafe-orange','cafe-gold','cafe-red']);for(const skin of SKINS)assert.deepEqual(Object.keys(skin.colors),Object.keys(SKINS[0].colors));assert.equal(getSkin('../outside').id,'classic');});
test('stored preference validates exact keys, IDs, version and mode',()=>{assert.ok(validPreference(DEFAULT_APPEARANCE));assert.equal(validPreference({...DEFAULT_APPEARANCE,arbitrary:true}),false);assert.equal(validPreference({...DEFAULT_APPEARANCE,schemaVersion:2}),false);assert.equal(validPreference({...DEFAULT_APPEARANCE,skinId:'../file'}),false);});
test('revision ordering rejects late, cross-session and malformed broadcasts',()=>{const current=snapshot('one',3);assert.equal(newerSnapshot(current,snapshot('one',4)),true);assert.equal(newerSnapshot(current,snapshot('one',3)),false);assert.equal(newerSnapshot(current,snapshot('one',1)),false);assert.equal(newerSnapshot(current,snapshot('two',4)),false);assert.equal(validSnapshot(snapshot('one',NaN)),false);assert.equal(newerSnapshot(null,current),true);});
