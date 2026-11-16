import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getDashboard } from '../services/campaignService.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const dashboard = await getDashboard(req.user.workspaceId);
  res.json(dashboard);
}));

export default router;
