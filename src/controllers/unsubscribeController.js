import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import * as recipientService from '../services/recipientService.js';

const tokenSchema = z.object({
  body: z.object({
    token: z.string().min(8),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const preview = asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const recipient = await recipientService.getUnsubscribePreview(token);
  res.json(recipient);
});

export const confirm = [
  validate(tokenSchema),
  asyncHandler(async (req, res) => {
    const result = await recipientService.unsubscribeByToken(req.validated.body.token);
    res.json(result);
  }),
];
