import { Router } from 'express';
import * as templatesController from '../controllers/templatesController.js';

const router = Router();

router.post('/', ...templatesController.create);
router.get('/', templatesController.list);
router.get('/:id', templatesController.getById);
router.delete('/:id', ...templatesController.remove);

export default router;
