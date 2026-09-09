import { Router } from 'express';
import * as campaignsController from '../controllers/campaignsController.js';

const router = Router();

router.post('/', ...campaignsController.create);
router.get('/', campaignsController.list);
router.delete('/:id', ...campaignsController.remove);
router.post('/:id/send', ...campaignsController.send);
router.post('/:id/test', ...campaignsController.testSend);
router.get('/:id/report', ...campaignsController.report);

export default router;
