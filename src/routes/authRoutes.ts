// src/routes/authRoutes.ts
import { Router } from 'express';
import { register, login, addBalance } from '../controllers/authController';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/wallet/deposit', addBalance);

export default router;