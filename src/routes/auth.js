import { Router } from 'express';
import * as authController from '../controllers/authController.js';

import * as googleController from '../controllers/googleController.js';

const router = Router();

router.get('/status', authController.status);
router.post('/register', ...authController.register);
router.post('/login', ...authController.login);
router.post('/logout', authController.logout);
router.post('/password', ...authController.changePassword);
router.get('/me', ...authController.me);
router.get('/team', ...authController.team);
router.post('/invites', ...authController.invite);
router.get('/invites/preview', authController.invitePreview);
router.post('/accept-invite', ...authController.acceptInvite);
router.get('/google', ...googleController.start);
router.get('/google/callback', googleController.callback);
router.post('/google/disconnect', ...googleController.disconnect);

export default router;
