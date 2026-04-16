import { Request, Response } from 'express';
import { FakeListChatModel } from '@langchain/core/utils/testing';

const healthModel = new FakeListChatModel({ responses: ['ok'] });

export async function handleHealth(req: Request, res: Response): Promise<void> {
  try {
    await healthModel.invoke('health check');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
}