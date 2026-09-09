import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import * as campaignService from '../services/campaignService.js';

const createCampaignSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    subject: z.string().min(1),
    templateId: z.string().uuid(),
    scheduledAt: z.coerce.date(),
    recipientIds: z.array(z.string().uuid()).min(1),
    notes: z.string().optional(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const campaignIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.any().optional(),
  query: z.any().optional(),
});

export const create = [
  validate(createCampaignSchema),
  asyncHandler(async (req, res) => {
    const campaign = await campaignService.createCampaign({
      ...req.validated.body,
      createdById: req.user.id,
    });
    res.status(201).json(campaign);
  }),
];

export const list = asyncHandler(async (_req, res) => {
  const campaigns = await campaignService.listCampaignsWithStats();
  res.json(campaigns);
});

export const send = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    const result = await campaignService.enqueueCampaign(req.validated.params.id);
    res.json({
      campaignId: result.campaign.id,
      status: result.campaign.status,
      enqueued: result.enqueued,
      failed: result.failed,
      skipped: result.skipped,
      errors: result.errors,
    });
  }),
];

export const report = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    const report = await campaignService.getCampaignReport(req.validated.params.id);
    res.json(report);
  }),
];

const testSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    email: z.string().email(),
  }),
  query: z.any().optional(),
});

export const testSend = [
  validate(testSchema),
  asyncHandler(async (req, res) => {
    const result = await campaignService.sendTestEmail({
      campaignId: req.validated.params.id,
      to: req.validated.body.email,
    });
    res.json(result);
  }),
];

export const remove = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    await campaignService.deleteCampaign(req.validated.params.id);
    res.json({ ok: true });
  }),
];
