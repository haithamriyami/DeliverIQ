import { Router } from 'express';
import multer from 'multer';
import * as recipientsController from '../controllers/recipientsController.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const router = Router();

router.post('/', ...recipientsController.create);
router.get('/', recipientsController.list);
router.delete('/:id', ...recipientsController.remove);
router.post('/import', upload.single('file'), recipientsController.importCsv);

export default router;
