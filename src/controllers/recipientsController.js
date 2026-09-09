import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import * as recipientService from '../services/recipientService.js';
import { HttpError } from '../middleware/errorHandler.js';

const createRecipientSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().min(1),
    timezone: z.string().min(1).optional(),
    notes: z.string().optional(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const create = [
  validate(createRecipientSchema),
  asyncHandler(async (req, res) => {
    const recipient = await recipientService.createRecipient(req.validated.body);
    res.status(201).json(recipient);
  }),
];

export const list = asyncHandler(async (_req, res) => {
  const recipients = await recipientService.listRecipients();
  res.json(recipients);
});

const recipientIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.any().optional(),
  query: z.any().optional(),
});

export const remove = [
  validate(recipientIdSchema),
  asyncHandler(async (req, res) => {
    await recipientService.deleteRecipient(req.validated.params.id);
    res.json({ ok: true });
  }),
];

export const importCsv = asyncHandler(async (req, res) => {
  let csvText = '';

  if (req.file?.buffer) {
    csvText = req.file.buffer.toString('utf8');
  } else if (typeof req.body?.csv === 'string') {
    csvText = req.body.csv;
  }

  if (!csvText.trim()) {
    throw new HttpError(400, 'Upload a CSV file or paste CSV text');
  }

  const summary = await recipientService.importRecipientsFromCsv(csvText);
  res.json(summary);
});
