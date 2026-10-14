import { Router } from 'express';
import * as sendingController from '../controllers/sendingController.js';

const router = Router();

router.get('/status', sendingController.status);
router.post('/tick', sendingController.tick);
router.post('/resume', ...sendingController.resumeSender);
router.get('/settings', sendingController.getSettings);
router.put('/settings', ...sendingController.updateSettings);
router.post('/sync-replies', sendingController.syncReplies);

export default router;
