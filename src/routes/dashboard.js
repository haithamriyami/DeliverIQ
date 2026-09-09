import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getDashboard } from '../services/campaignService.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  const dashboard = await getDashboard();
  res.json(dashboard);
}));

export default router;
