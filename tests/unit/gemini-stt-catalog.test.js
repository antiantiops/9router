import { expect, it, vi, afterEach } from 'vitest';
import provider from '../../open-sse/providers/registry/gemini.js';
import { handleSttCore } from '../../open-sse/handlers/sttCore.js';
afterEach(() => vi.unstubAllGlobals());
it('lists current batch models and keeps Live on its separate transport', () => {
 const models = provider.models.filter(m => m.kind === 'stt');
 expect(models.some(m => m.id.startsWith('gemini-2.'))).toBe(false);
 expect(models.find(m => m.id === 'gemini-3.8-live').transport).toBe('gemini-live');
 expect(models.find(m => m.id === 'gemini-3.8-flash').transport).toBeUndefined();
});
it('sends actual audio to current batch generateContent model', async () => {
 const fetch = vi.fn(async () => Response.json({ candidates: [{content:{parts:[{text:'Hello world.'}]}}] }));
 vi.stubGlobal('fetch', fetch);
 const formData = new FormData();formData.set('file', new File([new Uint8Array([82,73,70,70])], 'test.wav', {type:'audio/wav'}));
 const response = await handleSttCore({provider:'gemini',model:'gemini-3.8-flash',formData,credentials:{apiKey:'test-key'},sttConfig:provider.sttConfig});
 expect(await response.response.json()).toEqual({text:'Hello world.'});
 expect(fetch.mock.calls[0][0]).toContain('/gemini-3.8-flash:generateContent');
 const body=JSON.parse(fetch.mock.calls[0][1].body);
 expect(body.contents[0].parts[1].inline_data.data).toBe('UklGRg==');
});
