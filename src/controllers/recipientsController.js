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
    listId: z.string().uuid(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const createListSchema = z.object({
  body: z.object({
    name: z.string().min(1),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const moveRecipientSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    listId: z.string().uuid(),
  }),
  query: z.any().optional(),
});

export const create = [
  validate(createRecipientSchema),
  asyncHandler(async (req, res) => {
    const recipient = await recipientService.createRecipient(req.validated.body);
    res.status(201).json(recipient);
  }),
];

export const list = asyncHandler(async (req, res) => {
  const status = req.query.status;
  const allowed = ['active', 'bounced', 'unsubscribed'];
  const listId = typeof req.query.listId === 'string' ? req.query.listId : undefined;
  const recipients = await recipientService.listRecipients(
    allowed.includes(status) ? status : undefined,
    req.query.q,
    listId
  );
  res.json(recipients);
});

export const lists = asyncHandler(async (_req, res) => {
  const rows = await recipientService.listContactLists();
  res.json(rows);
});

export const createList = [
  validate(createListSchema),
  asyncHandler(async (req, res) => {
    const list = await recipientService.createContactList(req.validated.body.name);
    res.status(201).json(list);
  }),
];

const recipientIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.any().optional(),
  query: z.any().optional(),
});

export const move = [
  validate(moveRecipientSchema),
  asyncHandler(async (req, res) => {
    const recipient = await recipientService.moveRecipient(
      req.validated.params.id,
      req.validated.body.listId
    );
    res.json(recipient);
  }),
];

export const remove = [
  validate(recipientIdSchema),
  asyncHandler(async (req, res) => {
    await recipientService.deleteRecipient(req.validated.params.id);
    res.json({ ok: true });
  }),
];

export const removeBounced = asyncHandler(async (req, res) => {
  const listId = typeof req.query.listId === 'string' ? req.query.listId : undefined;
  const result = await recipientService.deleteBouncedRecipients(listId);
  res.json(result);
});

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

  const listId = req.body?.listId || req.query.listId;
  const summary = await recipientService.importRecipientsFromCsv(csvText, listId);
  res.json(summary);
});
