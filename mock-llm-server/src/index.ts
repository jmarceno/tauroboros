import express, { Request, Response } from 'express';
import cors from 'cors';
import { handleChatCompletion } from './openai-endpoint.js';
import { handleHealth } from './health.js';
import { handleModels } from './models-endpoint.js';

const app = express();
const PORT = process.env.PORT || 9999;

app.use(cors());
app.use(express.json());

app.get('/health', handleHealth);
app.get('/v1/models', handleModels);
app.post('/v1/chat/completions', handleChatCompletion);

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'mock-llm-server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      models: 'GET /v1/models',
      chat: 'POST /v1/chat/completions',
    },
  });
});

app.listen(PORT, () => {
  console.log(`[Mock LLM Server] Running on port ${PORT}`);
  console.log(`[Mock LLM Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Mock LLM Server] Chat: POST http://localhost:${PORT}/v1/chat/completions`);
});