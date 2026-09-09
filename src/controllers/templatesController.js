import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../middleware/errorHandler.js';

const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    body: z.string().min(1),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const create = [
  validate(createTemplateSchema),
  asyncHandler(async (req, res) => {
    const template = await prisma.template.create({
      data: req.validated.body,
    });
    res.status(201).json(template);
  }),
];

export const list = asyncHandler(async (_req, res) => {
  const templates = await prisma.template.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json(templates);
});

export const getById = asyncHandler(async (req, res) => {
  const template = await prisma.template.findUnique({
    where: { id: req.params.id },
  });

  if (!template) {
    throw new HttpError(404, 'Template not found');
  }

  res.json(template);
});

const templateIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.any().optional(),
  query: z.any().optional(),
});

export const remove = [
  validate(templateIdSchema),
  asyncHandler(async (req, res) => {
    const used = await prisma.campaign.count({
      where: { templateId: req.validated.params.id },
    });
    if (used > 0) {
      throw new HttpError(
        409,
        `This template is used by ${used} campaign${used === 1 ? '' : 's'}. Delete those campaigns first.`
      );
    }
    const existing = await prisma.template.findUnique({
      where: { id: req.validated.params.id },
    });
    if (!existing) {
      throw new HttpError(404, 'Template not found');
    }
    await prisma.template.delete({ where: { id: req.validated.params.id } });
    res.json({ ok: true });
  }),
];
