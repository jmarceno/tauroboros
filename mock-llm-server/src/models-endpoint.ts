import { Request, Response } from 'express';

export function handleModels(req: Request, res: Response): void {
  res.json({
    object: 'list',
    data: [
      {
        id: 'fake-model',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mock-server',
        permission: [],
        root: 'fake-model',
        parent: null,
      },
    ],
  });
}