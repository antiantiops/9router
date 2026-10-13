import {describe,it,expect} from 'vitest';
import provider from '../../open-sse/providers/registry/antigravity.js';
import {parseModel} from '../../open-sse/services/model.js';
import {getCapabilitiesForModel} from '../../open-sse/providers/capabilities.js';
import {MODEL_PRICING} from '../../open-sse/providers/pricing.js';
import {readFileSync} from 'node:fs';
describe('Antigravity Argon',()=>{
 it('routes canonical model without altering Flash',()=>{
 expect(parseModel('ag/gemini-4-argon').provider).toBe('antigravity');
 expect(provider.models.find(m=>m.id==='gemini-4-argon').upstreamModelId).toBe('gemini-4-argon');
 expect(provider.models.find(m=>m.id==='gemini-3.8-flash').upstreamModelId).toBe('gemini-3.8-flash-medium(medium)');
 });
 it('uses official synchronous capabilities and introductory pricing',()=>{
 const caps=getCapabilitiesForModel('antigravity','gemini-4-argon');
 expect(caps.contextWindow).toBe(1048576);expect(caps.maxOutput).toBe(65536);
 expect(caps.vision).toBe(true);expect(caps.audioInput).toBe(true);expect(caps.videoInput).toBe(true);
 expect(MODEL_PRICING['gemini-4-argon']).toEqual({input:2,output:10,cached:0.1});
 });
 it('lists model on all Antigravity surfaces',()=>{
 for(const file of ['src/mitm/config.js','src/shared/constants/cliTools.js','cli/src/cli/menus/providers.js','open-sse/services/usage/google.js'])expect(readFileSync(new URL('../../'+file,import.meta.url),'utf8')).toContain('gemini-4-argon');
 });
});
