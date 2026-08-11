import express from 'express';
import { asyncRoute } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { ttsLimiter } from '../middleware/rateLimit.js';
import { audit } from '../services/audit.js';
import { fishAudioStatus, synthesizeFishAudio } from '../services/fishAudio.js';

export const ttsRouter = express.Router();
ttsRouter.use(requireAuth);

ttsRouter.get('/status', asyncRoute(async (_req, res) => res.json(fishAudioStatus())));

ttsRouter.post(
  '/',
  ttsLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ text: z.string().trim().min(1).max(2_000) }), req.body);
    const audio = await synthesizeFishAudio(body.text);
    await audit({ actorId: req.user.id, action: 'fish_audio.tts_generated', meta: { characters: body.text.length, model: fishAudioStatus().model }, ip: clientIp(req) });
    res.set({ 'content-type': 'audio/mpeg', 'content-length': String(audio.length), 'cache-control': 'private, no-store', 'content-disposition': 'inline; filename="speech.mp3"' });
    return res.send(audio);
  }),
);
