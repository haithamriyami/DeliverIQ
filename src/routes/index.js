import { Router } from 'express';
import recipients from './recipients.js';
import campaigns from './campaigns.js';
import templates from './templates.js';
import webhooks from './webhooks.js';
import auth from './auth.js';
import dashboard from './dashboard.js';
import * as unsubscribeController from '../controllers/unsubscribeController.js';
import * as trackingController from '../controllers/trackingController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use('/auth', auth);
router.get('/t/o/:token', trackingController.openPixel);
router.get('/t/c/:token', trackingController.clickRedirect);
router.get('/unsubscribe', unsubscribeController.preview);
router.post('/unsubscribe', ...unsubscribeController.confirm);
router.use('/webhooks', webhooks);

router.use('/recipients', requireAuth, recipients);
router.use('/campaigns', requireAuth, campaigns);
router.use('/templates', requireAuth, templates);
router.use('/dashboard', requireAuth, dashboard);

export default router;
