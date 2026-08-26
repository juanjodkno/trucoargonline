// src/controllers/authController.ts
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';

const JWT_SECRET = process.env.JWT_SECRET || 'truco_secret_key_2026';

// 1. Registro de usuario
export async function register(req: Request, res: Response) {
  try {
    const { username, email, password, dni } = req.body;

    if (!username || !email || !password || !dni) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }, { dni }] },
    });

    if (existingUser) {
      return res.status(400).json({ error: 'El email, usuario o DNI ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        dni,
        balance: 0.00,
      },
      select: { id: true, username: true, email: true, dni: true, balance: true },
    });

    const token = jwt.sign({ userId: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ user: newUser, token });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
}

// 2. Login
export async function login(req: Request, res: Response) {
  try {
    const { emailOrUsername, password } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        dni: user.dni,
        balance: user.balance,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}

// 3. Cargar Fichas (1 ficha = $1 ARS)
export async function addBalance(req: Request, res: Response) {
  try {
    const { userId, amount, referenceId } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const [updatedUser, transaction] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { balance: { increment: amount } },
      }),
      prisma.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          amount,
          referenceId,
        },
      }),
    ]);

    res.json({ balance: updatedUser.balance, transaction });
  } catch (error) {
    res.status(500).json({ error: 'Error al acreditar saldo' });
  }
}