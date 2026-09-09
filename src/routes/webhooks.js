import { Router } from 'express';
import * as webhooksController from '../controllers/webhooksController.js';

const router = Router();

router.post('/sendgrid', webhooksController.handleSendGrid);

export default router;
