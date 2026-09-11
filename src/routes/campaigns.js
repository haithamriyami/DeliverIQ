import { Router } from 'express';
import * as campaignsController from '../controllers/campaignsController.js';

const router = Router();

router.post('/', ...campaignsController.create);
router.get('/', campaignsController.list);
router.post('/sync-bounces', campaignsController.syncBounces);
router.delete('/:id', ...campaignsController.remove);
router.post('/:id/send', ...campaignsController.send);
router.post('/:id/follow-up', ...campaignsController.followUp);
router.post('/:id/test', ...campaignsController.testSend);
router.get('/:id/report', ...campaignsController.report);
router.get('/:id/audience', ...campaignsController.audience);
router.get('/:id/bounces', ...campaignsController.audience);

export default router;
