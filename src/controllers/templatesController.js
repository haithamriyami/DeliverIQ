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
      data: { ...req.validated.body, workspaceId: req.user.workspaceId },
    });
    res.status(201).json(template);
  }),
];

export const list = asyncHandler(async (req, res) => {
  const templates = await prisma.template.findMany({
    where: { workspaceId: req.user.workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(templates);
});

export const getById = asyncHandler(async (req, res) => {
  const template = await prisma.template.findFirst({
    where: { id: String(req.params.id), workspaceId: req.user.workspaceId },
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

const updateTemplateSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
  }),
  query: z.any().optional(),
});

export const update = [
  validate(updateTemplateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.template.findFirst({
      where: { id: req.validated.params.id, workspaceId: req.user.workspaceId },
    });
    if (!existing) {
      throw new HttpError(404, 'Template not found');
    }
    const template = await prisma.template.update({
      where: { id: req.validated.params.id },
      data: req.validated.body,
    });
    res.json(template);
  }),
];

export const remove = [
  validate(templateIdSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.template.findFirst({
      where: { id: req.validated.params.id, workspaceId: req.user.workspaceId },
    });
    if (!existing) {
      throw new HttpError(404, 'Template not found');
    }
    const used = await prisma.campaign.count({
      where: { templateId: req.validated.params.id },
    });
    if (used > 0) {
      throw new HttpError(
        409,
        `This template is used by ${used} campaign${used === 1 ? '' : 's'}. Delete those campaigns first.`
      );
    }
    await prisma.template.delete({ where: { id: req.validated.params.id } });
    res.json({ ok: true });
  }),
];
